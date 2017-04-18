/**
 * 基本的实例，单机队列控制
 * @param engine
 * @param settings
 */
var instance = function(engine, settings){
    this.engine = engine;
    this.settings = settings;
    this.queue = [];
};

instance.prototype.length = function(){
    return this.queue.length;
};

instance.prototype.shift = function(){
    return this.queue.shift();
};

instance.prototype.push = function(url_info){
    return this.queue.push(url_info);
};

instance.prototype.init_queue = function(){
    /**
     * 通过配置文件添加初始化链接
     * [
     *      {link: url, meta: {type: index, spider: domain}}
     * ]
     */
    for(var i in this.settings.start_url){
        this.push(this.settings.start_url[i]);
    }
};

module.exports = instance;