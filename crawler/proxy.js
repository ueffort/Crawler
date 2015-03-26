/**
 * 蜘蛛工厂，调度链接所需的蜘蛛
 * 监听列表：
 *      proxy(callback(err, host, port, callback(err, milliseconds))): 获取一个代理信息，并且下载后回调该callback
 * 代理格式：
 *      ip:port  timestamp:某个时刻后才能被使用，在获取后会更新该数值，保证多进程间不调用同一个代理地址
 */

var util = require('util');
var events = require('events');
var async = require('async');
var redis = require('redis');
var _ = require('underscore')._;

var default_settings = {
    redis: {
        host: '127.0.0.1'
        ,port: '6379'
    }
    ,redis_key: 'proxy'//在redis中代理集合的key
    ,waring_num: 15//代理告警限制，还剩多少代理后发出警报
    ,download_times: 10//每个代理下载几次重新获取新代理，避免被封
};

var proxy = function(engine, settings, init_callback){
    events.EventEmitter.call(this);
    this.engine = engine;
    this.settings = _.extend(default_settings, settings);
    this.key = settings.redis.key;
    this.redis = redis.createClient(settings.redis.port, settings.redis.host);
    this.proxy_list = [];
    var self = this;
    updateLength(self, init_callback);
};

//更新代理列表数量
function updateLength(self, callback){
    self.redis.zcard(this.key, function(err, result){
        self.length = result;
        //发送告警
        if(self.length < self.settings.waring_num) self.engine.logger.warning('[ PROXY ] proxy num is %s', self.length);
        callback(err, result);
    });
}

//解析代理数据格式
function parseProxy(info){
    if(_.isObject(info)){
        return info;
    }
    var object = info.split(':');
    return {host: object[0], port: object[1], info:info, times:0, error:0, score:0};
}

//代理结果回写代理状态
function callbackProxy(self, object){
    return function(err, milliseconds){
        object.times+=1;
        if(err){
            object.error+=1;
            if(self.settings.download_times == object.error){
                return self.redis.zrem(self.key, object.info);
            }
        }
        //将下载时间累加
        object.score += milliseconds;
        //下载完重新进入代理队列
        if(self.settings.download_times != object.times)
            self.proxy_list.push(object);
        else
        //调整该代理的优先级
            self.redis.zincrby(self.key, object.info, parseInt(object.score/1000));
    }
}

proxy.on('proxy', function(next_callback){
    var self = this;
    var time_stamp = parseInt(new Date().getMilliseconds()/1000);
    async.waterfall([
        function(callback){
            if(self.proxy_list.length) return callback(1, self.proxy_list.pop());
            callback(null);
        },
        function(callback){
            //获取时间戳最小的代理，保证每个代理都能被获取到
            self.redis.zrange(self.key, 0, 1, 'WITHSCORES', callback);
        },
        function(result, callback){
            //每次调用后延后1分钟后可被调用,数值自我修正，多少秒无实际意义
            //保证不会在多进程中都获取到同一个代理
            self.redis.zincrby(self.key, result[0], time_stamp+60-result[1]);
            updateLength(self, function(err, length){
                callback(err, result[0]);
            });
        }
    ], function(err, info){
        if(!info) return next_callback(err);
        var proxy = parseProxy(info);
        next_callback(null, proxy.host, proxy.port, callbackProxy(self, proxy));
    });

});

module.exports = proxy;
