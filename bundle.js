'use strict';
var optimize = require('amd-optimizer');
var gutil = require('gulp-util');
var through = require('through');
var fs = require('fs');
var path = require('path');
var slash = require('slash');

var File = gutil.File;
var Buffer = require('buffer').Buffer;
var PluginError = gutil.PluginError;
var baseName = /^(.*?)\.\w+$/;

function loadFile(path, name, done){
    fs.readFile(path, function(err, contents){
        if(err) return done(err);
            var file = new File({
            path: path,
            contents: contents
        });
        file.name = name;
        done(null, file);
    })
}


var is_run = false;

/* 檔案處理佇列 */
var queues = [];
function addQueues(callback) {
    queues.push(callback);
    if (! is_run) {
        run();
    }
}
function run () {
    is_run = true;
    if (queues.length > 0) {

        var q = queues.shift();
        q().then(() => {
            run();
        });
    } else {
        is_run = false;
    }
};



module.exports = function (config, options) {

    if(config == undefined || 'baseUrl' in config == false){
        throw new PluginError('gulp-amd-optimize', 'baseUrl is required in the config');
    }

    options = options || {};

    var sourceMapSupport = false;
    var cwd;

    var optimizer = optimize(config, options);


    optimizer.on('dependency', function (dependency) {
        addQueues(function() {
            return new Promise(next => {
                var dep = Object.assign({}, dependency);
                var txt_file = (dep.path.indexOf(path.join(config.baseUrl, 'text-load')) === 0);
                var css_file = (dep.path.indexOf(path.join(config.baseUrl, 'css-load')) === 0);
                var lib_file = (dep.path.indexOf(path.join(config.baseUrl, 'libs')) === 0);

                var real_path = dep.path;
                if (txt_file) {
                    real_path = real_path.replace(/.js$/, '').replace(/text-load/, '');
                }
                if (css_file) {
                    real_path = real_path.replace(/.js$/, '.css').replace(/css-load/, '');
                }
                console.info(` add file >> ${real_path} `);
                loadFile(real_path, dep.name, (err, file) => {
                    if (err) {
                        optimizer.error('Could not load `'+dependency.name+'`\n required by `'+dependency.requiredBy+'`\n from path `'+dependency.path+'`\n because of '+err);
                    } else {
                        if (txt_file) {
                            var html = file.contents.toString().split('\n').map(str => str.trim()).join('\\n ');
                            html = html.replace(/\'/g, "\\'");
                            file.contents = new Buffer(`define(() => '${html}');`, 'utf8');
                        } else if (css_file) {
                            var style = file.contents.toString().split('\n').map(str => str.trim()).join('');
                            style = style.replace(/\'/g, "\\'");
                            file.contents = new Buffer(([
                                'define(function() { ',
                                'var css = document.createElement("style");',
                                'css.innerHTML = `' + style + '`;',
                                'document.body.appendChild(css);',
                                'return null;',
                                '});',
                            ]).join('\n'),'utf8');
                        } else if (lib_file) {
                            let dname = dependency.name;

                            /* 取得相依性套件 */
                            let deps = config.shim && (dname in config.shim) && config.shim[dname].deps || [];

                            /* 將相依套件轉為字串 */
                            deps = deps.length === 0 ?
                                '' :
                                deps.map(name => {
                                    return `'${name}'`;
                                }).join(',');

                            var code = ([
                                `define([${deps}], (...requires)=> {`,
                                '   var _my_api = () => null;',
                                '   var define = (...args) => (_my_api = args.pop());',
                                '   define.amd = true;',
                                file.contents.toString() + ';',
                                '   return typeof _my_api === "function" ? _my_api.apply(null, requires) : _my_api;',
                                '});',
                            ]).join('\n');
                            file.contents = new Buffer(code, 'utf8');
                        }
                        file.path = dependency.name;
                        optimizer.addFile(file);
                        next();
                    }
                });
            })
        });
    });


    function onData(file) {
        if (file.isNull()) {
            this.push(file);
        }

        if(file.sourceMap){
            sourceMapSupport = true;
        }

        if (file.isStream()) {
            this.emit('error', new PluginError('gulp-amd-optimize', 'Streaming not supported'));
            return
        }
        cwd = file.cwd;
        file.name = baseName.exec(file.relative)[1];
        try {
            optimizer.addFile(file);

        } catch (err) {
            console.info('******************');
            console.info(' :: JS ERROR :: ');
            console.info(' >> ', file.path);
            throw  err;
        }

    }

    function onEnd(){
        optimizer.done(function(output){
            output.forEach(function(module){
                var file = new File({
                    path: module.name,
                    base: path.join(cwd, config.baseUrl),
                    cwd: cwd,
                    contents: new Buffer(module.content + '\n\n')
                });

                if(sourceMapSupport){
                    module.map.sourcesContent = [module.source];

                    file.sourceMap = module.map;
                }
                this.queue(file);
            }.bind(this));
            this.queue(null);
        }.bind(this));
    }

    var transformer = through(onData, onEnd);

    optimizer.on('error', function(error){
        transformer.emit('error', error);
    });

    return transformer;
};
