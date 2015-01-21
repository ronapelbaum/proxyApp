/**
 * Created by apelbaur on 3/27/14.
 */
var https = require('https');
var http = require('http');
//var net = require('net');
//var tls = require('tls');
var fs = require('fs');
var path = require('path');
var url = require('url');
var qs = require('querystring');
var httpProxy = require('http-proxy');
var proxyUtil = require('./proxyUtil.js');

console.log('proxyApp started at: %s\ncache dir is set to: %s', new Date(), proxyUtil.cacheDir);
//create sll connection
var sslKeyDir = path.join('.', 'key');
var httpsOpts = {
    key: fs.readFileSync(path.join(sslKeyDir, 'agent2-key.pem'), 'utf8'),
    cert: fs.readFileSync(path.join(sslKeyDir, 'agent2-cert.pem'), 'utf8')
};

//server state
var isRecording = true;


// Create the target HTTP server
var myHttpServer = http.createServer(function (req, res) {
    console.log('server:%s. req: %s', proxyUtil.ports.http, req.url);
    proxyLogic(req, res, httpProxy.createProxyServer());
});
myHttpServer.on('error', function (err) {
    logError('error in server ' + proxyUtil.ports.http, err);
});
//TODO!!! - handle HTTPS case
myHttpServer.on('connect', function (request, socket, head) {
    console.log('connect (%s): %s', proxyUtil.ports.http, request.url);
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');

//    var sslSocket = net.connect({host: 'myd-vm05181.hpswlabs.adapps.hp.com', port: 443}, function () {
//        console.log('new socket!');
//        this.pipe(socket);
//    });
//    sslSocket.on('error', function (e) {
//        console.error('1' + e.stack);
//    })
});
myHttpServer.listen(proxyUtil.ports.http, function () {
    return console.log('http server started on port %s at: %s', proxyUtil.ports.http, proxyUtil.time());
});


// Avoids DEPTH_ZERO_SELF_SIGNED_CERT error for self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Create the target HTTPS server
var myHttpsServer = https.createServer(httpsOpts, function (req, res) {
//    console.log('server:%s. req: %s', proxyUtil.ports.http, req.url);
    proxyLogic(req, res, httpProxy.createProxyServer({
        ssl: httpsOpts,
        secure: false
    }));
});
myHttpsServer.on('error', function (err) {
    logError('error in server ' + proxyUtil.ports.https, err);
});
myHttpsServer.on('connect', function (err) {
    console.log('connect (%s)', proxyUtil.ports.https);
});
myHttpsServer.listen(proxyUtil.ports.https, function () {
    return console.log('https server started on port %s', proxyUtil.ports.https);
});


//delete all cache before starting
proxyUtil.deleteFolderRecursive(proxyUtil.cacheDir, false);


/**
 * this is the proxy logic
 * @param req
 * @param res
 * @param myProxy
 */
function proxyLogic(req, res, myProxy) {

    if (proxyUtil.isProxyChange(req.url)) {

        //explicit call to proxy to change state
        isRecording = !isRecording;
        console.log('@@@ isRecording = %s at %s @@@', isRecording, proxyUtil.time());
        //response
        res.writeHead(200);
        res.end('respond from http server at: ' + proxyUtil.time() + '\nisRecording=' + isRecording);

    } else {

        if (proxyUtil.isWhiteList(req)) {

            //whiteList requests are passing through...
            proxyRequest(myProxy, req, res);

        } else {

            var query;
            //handle query for POST
            if (req.method == 'POST') {
                var body = '';
                req.on('data', function (data) {
                    body += data;
                });
                req.on('end', function () {
                    //query will update for POST only after req.end!
//                    query = qs.parse(body);//TODO???
                    query = body;
                });
            } else if (req.method == 'GET') {
                query = url.parse(req.url, true).query;
            }

            if (isRecording) {
                // Listen for the `proxyRes` event
                myProxy.on('proxyRes', function (res) {
                    console.log('proxyRes for: %s - %s', req.url, JSON.stringify(query));
                    //we can use 'query' here, since myProxy.proxyRes is after req.end
                    var filePath = proxyUtil.getFilePath(req, query);
                    proxyUtil.verifyPath(filePath);
                    try {
                        pipeResponseToFile(res, filePath);
                    } catch (err) {
                        logError('error in pipeResponseToFile', err);
                    }
                });
                //proxy the request
                proxyRequest(myProxy, req, res);

            } else {
                var replayRes = function () {

                        console.log('replayRes for: %s - %s', req.url, JSON.stringify(query));

                        //try to play response from file
                        var filePath = proxyUtil.getFilePath(req, query);
                        var matchingFilePath = proxyUtil.getMatchingFilePath(filePath);
                        try {

                            pipeResponseFromFile(res, matchingFilePath);
                        } catch (err) {
                            if (err.code === 'ENOENT') {
                                var queryMsg = query && JSON.stringify(query).length > 0 ? '\tquery: ' + JSON.stringify(query) : '';
                                console.error('no response for: %s%s\n\tfilePath: %s', req.url, queryMsg, matchingFilePath);
                            } else {
                                logError('error in pipeResponseFromFile', err);
                            }
                        }
                    }
                    ;

                //replay result
                if (req.method == 'POST') {//TODO ===?
                    //if we are in POST, so 'query' will have value only at req.end
                    req.on('end', replayRes);
                } else if (req.method == 'GET') {
                    replayRes();
                }


            }
        }

    }
}

/**
 * pipe the response to a file in order to cache it
 * @param res
 * @param filePath
 */
var pipeResponseToFile = function (res, filePath) {
//    console.log('pipeResponseToFile: %s', filePath);
    //create the writeStream
    if (fs.existsSync(filePath))return;//TODO make sure not to overwrite the existing file
    var writeStream = fs.createWriteStream(filePath);
    res.pipe(writeStream);
    res.on('end', function () {
        //persist headers for current path
        fs.writeFile(proxyUtil.getHeadersPath(filePath), JSON.stringify(res.headers), function (err) {
            logError('writeHeadersFile', err);
        });
        //TODO end the stream???
        writeStream.end();
    });
    res.on('error', function (err) {
        logError('pipeResponseToFile:response', err);
    });
    writeStream.on('error', function (err) {
        logError('pipeResponseToFile:writeStream: ' + filePath, err);

    });
    writeStream.on('finish', function () {
        console.log('respond piped to file: %s', filePath);
    });
};

/**
 * pipe the response from a cached file
 * @param res
 * @param filePath
 */
var pipeResponseFromFile = function (res, filePath) {
    filePath = proxyUtil.getMatchingFilePath(filePath);

//    console.log('pipeResponseFromFile: %s', filePath);
    //verify that we have access to the file
    var headersPath = filePath + proxyUtil.headerSuffix;
    fs.statSync(headersPath);
    //set the headers
    var headers = JSON.parse(fs.readFileSync(headersPath, 'utf8'));

    for (var key in  headers) {
        res.setHeader(key, headers[key]);
    }
    res.writeHead(200);

    //verify that we have access to the file
    fs.statSync(filePath);
    //create the piping
    var readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
    readStream.on('end', function () {
        console.log('respond piped from file: %s', filePath);
        res.end();
    });
    readStream.on('error', function (err) {
        logError('pipeResponseFromFile:readStream', err);
        res.end();
    });
    res.on('error', function (err) {
        logError('pipeResponseFromFile:response', err);
    });
};

/**
 * use the given proxy to web proxy the req to the target
 * uses getProxyTarget(req)
 * @param proxy
 * @param req
 * @param res
 */
var proxyRequest = function (proxy, req, res) {
    proxy.web(req, res, proxyUtil.getProxyTarget(req));
};


/**
 * log an error message to console
 * @param errMsg
 * @param err
 */
function logError(errMsg, err) {
    if (err) console.error('%s\n%s', errMsg, err.stack);
}

//catch all errors
process.on('uncaughtException', function (err) {
    logError('General Error!', err);
});


