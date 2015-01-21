/**
 * Created by apelbaur on 3/23/14.
 */
var url = require('url');
var fs = require('fs');
var path = require('path');
var os = require('os');
var qs = require('querystring');
var mkpath = require('mkpath');
var dateUtils = require('date-utils');


//var cacheDir = 'c:\\myCache';
var cacheDir = process.argv[2] || 'c:\\proxyApp\\cache';
var headersFileSuffix = '_HEADERS';

var Q_MARK = '@';
var Q_DELIM = '^';

//exported vars
exports.ports = {http: 8082, https: 443};
exports.cacheDir = cacheDir;
exports.headerSuffix = headersFileSuffix;

var whiteList = [
    'hpmobilemon',
    'www.google-analytics.com',
    'favicon.ico'
];
/**
 * does the request contains a whiteList token
 * @param req
 * @returns {boolean}
 */
exports.isWhiteList = function (req) {
    for (var i = 0; i < whiteList.length; i++) {
        if (req.url.indexOf(whiteList[i]) >= 0) {
//            console.log('whiteList: %s', req.url);
            return true;
        }
    }
    return false;
};


var secondaryProxy;
//secondaryProxy = {target: {host: 'rhvwebcachevip.bastion.europe.hp.com', port: 8080}};
secondaryProxy = {target: {host: 'web-proxy.isr.hp.com', port: 8080}};

/**
 * get the proxy target from request
 * @param req
 * @returns {*}
 */
var getProxyTarget = function (req) {

    if (secondaryProxy) {
        return secondaryProxy;
    }
    var reqUrl = url.parse(req.url);

    return {
        target: {
            host: (reqUrl.hostname ? reqUrl.hostname : 'localhost'),
            port: (reqUrl.port ? reqUrl.port : 80)
        }
    };
};
exports.getProxyTarget = getProxyTarget;


/**
 * is the proxy the actual target
 * @param url
 * @returns {boolean}
 */
var isProxyChange = function (url) {
    //TODO improve this!
    return  url.indexOf('changeState') >= 0 && (url.indexOf('/') == 0 || url.indexOf('localhost') >= 0 || url.indexOf(os.hostname()) >= 0);
};
exports.isProxyChange = isProxyChange;


/**
 * get the proper file path for caching the request
 * @param req
 * @returns {*}
 * @param query
 */
var getFilePath = function (req, query) {
    var reqUrl = url.parse(req.url);

    function fsCompatible(str) {
        if (str.length > 220) str = str.hashCode();
        return str && str.length > 0 ? str.replace(/\?/g, Q_MARK).replace(/:|;|>|<|\|,/g, '_') : '';
    }

    function stringifyQuery(q) {
        var qStr = JSON.stringify(q);
        if (!q || qStr === '{}') {
            return '';
        } else {
//            return qStr.replace(/,/g, Q_DELIM);

            var res = '';
            qStr = qStr.replace(/{|}|"|\\|\//g, '').replace(/:/g, '=');

            var array = qStr.split(',');
            for (var i in array) {
                if (i > 0)res += Q_DELIM;
                res += array[i].hashCode();
            }
            return res;
        }
    }

    query = fsCompatible(stringifyQuery(query));

//    query = query.hashCode();
//    query = query === 0 ? '' : '' + query;


    query = query.length > 0 ? Q_MARK + query : '';

    var hostname = '' + reqUrl.hostname;
    var pathname = '' + reqUrl.pathname;
    var lastIndexOf = pathname.lastIndexOf('/');
    if (lastIndexOf > 0) {
        var dirName = fsCompatible(pathname.substr(0, lastIndexOf));
        var fileName = fsCompatible(pathname.substr(lastIndexOf));
        fileName = fileName.length > 0 ? fileName : ' ';
        pathname = dirName + fileName;
    } else {
        fileName = fsCompatible(pathname);
        pathname = fileName.length > 0 ? fileName : ' ';
    }

    var relPath = path.join(hostname, pathname + query);
//    var relPath = reqUrl.hostname +'/'+ fsCompatible(reqUrl.pathname + stringifyQuery(query)).hashCode();
//    console.log('getFilePath: time: %s\n\trequest:\t%s\n\trelPath:\t%s', (new Date).getTime(), req.url.toString().substr(7), relPath);
    return  path.join(cacheDir, relPath);
};
exports.getFilePath = getFilePath;


/**
 * get filePath of a matching file - by Q params
 * @param filePath
 * @returns {string}
 */
var getMatchingFilePath = function (filePath) {
    var origDir = path.dirname(filePath);
    var origFile = path.basename(filePath);
    var targetFile;
    var targetGrade = 0;
    var files = fs.readdirSync(origDir);

    function getQueryParams(filename) {
        return filename.indexOf(Q_MARK) > 0 ? (filename.substr(filename.indexOf(Q_MARK) + 1)).split(Q_DELIM) : undefined;
    }


    function matchGrade(arr1, arr2) {
        var grade = 0;
        //TODO improve this loop!
        for (var j in arr1) {
            for (var k in arr2) {
                if (arr1[j] === arr2[k])
                    grade++;
            }
        }
        return grade;
    }

    for (var i in files) {
        //check first for file itself!
        if (origFile === files[i]) {
            targetFile = files[i];
            break;
        } else {
            //try to grade file names
            var origQParams = getQueryParams(origFile);
            var currQParams = getQueryParams(files[i]);

            if (origQParams && currQParams) {
                var grade = matchGrade(origQParams, currQParams);
                if (grade > targetGrade) {
                    targetFile = files[i];
                    targetGrade = grade;
                }
            }
        }
    }
    if (targetFile !== origFile)console.log('getMatchingFilePath: \n\t%s\n\t%s', origFile, targetFile);

    return targetFile ? path.join(origDir, targetFile) : path.join(origDir, origFile); //TODO??
};
exports.getMatchingFilePath = getMatchingFilePath;

var getHeadersPath = function (filePath) {
    var headersPath = path.join(path.dirname(filePath), headersFileSuffix, path.basename(filePath));
    verifyPath(headersPath);
    return  headersPath;
};
exports.getHeadersPath = getHeadersPath;

/**
 * delete a folder and all it's content (recursive!)
 * @param path
 * @param remRootDirFlag [optional] boolean if to remove dir itself
 */
var deleteFolderRecursive = function (path, remRootDirFlag) {
//    console.log('deleteFolderRecursive: ' + path);

    if (fs.existsSync(path)) {
        fs.readdirSync(path).forEach(function (file, index) {
            var curPath = path + "/" + file;
            if (fs.lstatSync(curPath).isDirectory()) { // recurse
                deleteFolderRecursive(curPath);
            } else { // delete file
                fs.unlinkSync(curPath);
            }
        });
        if (!!remRootDirFlag || path !== cacheDir) fs.rmdirSync(path);
    }
};
exports.deleteFolderRecursive = deleteFolderRecursive;

/**
 * get current time
 * @returns {*}
 */
var time = function time() {
    var date = new Date();
    return date.toFormat('YYYY-MM-DD HH24:MI:SS');
};
exports.time = time;

/**
 * verify that the path exists, and if not, creates the dir (but not the file)
 * @param filePath
 */
var verifyPath = function (filePath) {
//    console.log('verifyPath. filePath %s', filePath);
    var fileDir = path.dirname(filePath);
    if (fs.existsSync(fileDir)) {
        return;
    }
    try {
        mkpath(fileDir);
        mkpath.sync(fileDir);
    } catch (err) {
        console.error('verifyPath: ' + filePath, err);
    }
};
exports.verifyPath = verifyPath;


//-----------------
/**
 * create a hashCode from a string
 * http://stackoverflow.com/questions/7616461/generate-a-hash-from-string-in-javascript-jquery
 * http://erlycoder.com/49/javascript-hash-functions-to-convert-string-into-integer-hash-
 *
 * @returns {number}
 */
String.prototype.hashCode = function () {
    var hash = 0, i, chr, len;
    if (this.length == 0) return hash;
    for (i = 0, len = this.length; i < len; i++) {
        chr = this.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0; // Convert to 32bit integer
    }
//    if (hash === 0)hash = ''; //TODO??

    return hash;
};
