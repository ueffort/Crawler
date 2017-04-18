/**
 * 实例调度器，处理单个实例调度
 * 事件列表：
 *      finish_queue(err):结束一个时间分片,是否自动循环抓取
 *      wait_queue(err):等待队列初始化
 * 监听列表：
 *      start(callback(err)): 启动
 *      stop(callback(err))：关闭
 *      pause(callback(err))：暂停
 *      resume(callback(err))：恢复
 *      init_queue(callback(err, queue_length))：初始化一个时间分片
 *      push(link, meta, callback(err)):将url入队操作
 */

var util = require('util');
var events = require('events');
var async = require('async');
var _ = require('underscore')._;

var default_settings = {
    parallel: 4//同时开启多少个下载work
    ,frequency: 4//每分钟的下载频率限制，最高下载数限制
    ,loop: false//下载队列完成后，是否重新开始
};

var scheduler = function(engine, settings, init_callback){
    events.EventEmitter.call(this);
    this.started = false;
    this.engine = engine;
    this.settings = _.defaults(settings, default_settings);
    engine.logger.silly('[ SCHEDULER ] init ', this.settings);
    var self = this;
    event_init(this);
    this.engine.on('finish_init', function(){
        self.engine.emit('downloader', function(err, downloader){
            self.downloader = downloader;
        });
        self.engine.emit('instance', function(err, instance){
            self.instance = instance;
        });
    });
    if(!this.settings.parallel) this.settings.parallel = 1;
    //单个下载的时间限制
    var download_time_limit = this.settings.frequency ?
        parseInt(60000 / this.settings.frequency / this.settings.parallel) : 0;
    //同时开启多少个下载队列
    this.queue = async.queue(function(task, callback){
        self.engine.logger.silly('[ SCHEDULER ] queue ',task);
        if(!task.meta.times) task.meta.times = 1;
        self.downloader.emit('download', task.link, task.meta, function(err, milliseconds){
            if(err){
                //todo 针对下载错误
                if(task.meta.times < self.settings.retry || self.settings.retry < 0){
                    task.meta.times += 1;
                    self.queue.push(task);
                }
            }
            if(download_time_limit > milliseconds){
                setTimeout(callback, download_time_limit - milliseconds);
                self.engine.logger.silly('[ SCHEDULER ] queue wait ', parseFloat(download_time_limit - milliseconds) / 1000);
            }else{
                callback();
            }
        });
    }, this.settings.parallel);
    this.queue.empty = function(){
        var length = self.instance.length();
        if(length==0) return ;
        self.engine.logger.silly('[ SCHEDULER ] queue empty, get url from instance queue');
        self.started = true;
        //填充下载队列
        async.whilst(function(){
            return self.queue.length() == 0 && self.instance.length() > 0;
        }, function(callback){
            var info = null;
            try{
                info = self.instance.shift();
            }catch(e){
                self.engine.logger.debug(e);
            }
            self.queue.push(info);
            callback(null);
        }, function(err) {
            if(self.instance.length()==0){
                self.engine.logger.info('[ SCHEDULER ] instance queue is empty, wait work end');
            }
        });
    };
    this.queue.drain = function(){
        async.waterfall([
            function(callback){
                self.engine.emit('spider', callback);
            },
            function(spider, callback){
                if(spider.running == 0) return callback();
                spider.once('empty', callback);
            }
        ],function(err){
            if(self.instance.length())
                self.queue.schedule();
            else{
                self.engine.logger.info('[ SCHEDULER ] instance queue is empty, finish_queue!');
                self.emit('finish_queue', null);
            }
        });
    };
    this.queue.schedule = function(){
        if(this.paused){
            this.resume();
            self.engine.logger.silly('[ SCHEDULER ] resume work queue');
        }
        if(this.length()==0) this.empty();
        if(!self.instance.length() && !self.started){
            self.engine.logger.info('[ SCHEDULER ] instance queue is empty, wait_queue!');
            self.emit('wait_queue', null);
        }
    };
    init_callback(null, this);
};
util.inherits(scheduler, events.EventEmitter);

function event_init(scheduler){
scheduler.on('init_queue', function(callback){
    //避免第一次执行实例，队列为空
    if(!this.settings.loop && this.started)
        return callback(this.engine.error.SCHEDULER_NO_NEED_LOOP_QUEUE);
    this.engine.logger.info('[ SCHEDULER ] start init instance queue!');
    var err = null;
    var length = 0;
    try{
        if(!this.instance.length()) this.instance.init_queue();
        length = this.instance.length();
        this.engine.logger.silly('[ SCHEDULER ] instance init queue length ', length);
    }catch(e){
        this.engine.logger.debug(e);
    }
    if(!length) {
        this.engine.logger.error('[ SCHEDULER ] instance has 0 queue length after init_queue!');
        err = this.engine.error.SCHEDULER_QUEUE_ERROR;
    }
    if(!err){
        this.queue.schedule();
    }
    callback(err, length);
});

scheduler.on('stop',function(callback){
    this.engine.logger.info("[ SCHEDULER ] stop");
    this.queue.kill();
    callback(null);
});

scheduler.on('start',function(callback){
    this.engine.logger.info("[ SCHEDULER ] start");
    var err = null;
    if(!this.queue){
        this.engine.logger.error('[ SCHEDULER ] queue is error!');
        err = this.engine.error.SCHEDULER_START_ERROR;
    }else{
        if (this.started) {
            this.engine.logger.warn('[ SCHEDULER ] scheduler is running! not need start again!');
        }
        this.queue.schedule();
    }
    callback(err);
});

scheduler.on('pause', function(callback){
    this.engine.logger.info("[ SCHEDULER ] pause");
    var err = null;
    if(!this.started){
        this.engine.logger.error('[ SCHEDULER ] scheduler not start, so can not pause');
        err = this.engine.error.SCHEDULER_PAUSE_ERROR;
    }else{
        this.queue.pause();
    }
    callback(err);
});

scheduler.on('resume', function(callback){
    this.engine.logger.info("[ SCHEDULER ] resume");
    var err = null;
    if(!this.queue.paused){
        this.engine.logger.error('[ SCHEDULER ] queue is not paused, so not need resume');
        err = this.engine.error.SCHEDULER_RESUME_ERROR;
    }else{
        this.queue.resume();
    }
    callback(err);
});

scheduler.on('push', function(link, meta, callback){
    this.engine.logger.info("[ SCHEDULER ] push ", link, meta);
    var err = null;
    try{
        this.instance.push({ link, meta });
        this.queue.schedule();
    }catch(e){
        this.engine.logger.debug(e);
        this.engine.logger.error('[ SCHEDULER ] instance can not push link!');
        err = this.engine.error.SCHEDULER_PUSH_ERROR;
    }
    callback(err);
});
}

module.exports = scheduler;