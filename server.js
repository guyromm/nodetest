/*this script checks out the redis pub/sub */
_ = require('underscore');
fs = require('fs');
sys = require('sys');
http = require('http');
redis = require('redis'),client=redis.createClient(),ps=redis.createClient();

client.on("error", function (err) {    console.log("Error " + err);});
ps.on("error", function (err) {    console.log("Error " + err);});

url = require('url');

console.log('loaded modules');


var tplsrc = fs.readFileSync('tpl.html','utf-8');

console.log('read template');



http.createServer(function (req, res) {
    var pathname = url.parse(req.url).pathname;
    if (pathname =='/favicon.ico') {
	res.end('');
	return;
    }

    var sres = /\/subscribe\:(.+)$/.exec(pathname);
    //console.log(pathname+'=>'+sres);
    if (sres)
    {
	res.writeHead(200,{'Content-Type':'text/plain'});
	var spath = '/'+sres[1];
	console.log('subscribing to "'+spath+'"');
	ps.on("message",function(chan,msg) {
	    
	    console.log('subscribe event arrived in the form of '+msg);
	    if (msg=='finished')
		res.end(msg);
	    else
		res.write(msg+'\n'); //'<script>'+msg+'</script>');
	});
	ps.subscribe(spath);
	console.log('setting message event handler');


    }
    else
    {
	var cnt = client.incr(pathname,function(err,cnt) { 
	    res.writeHead(200, {'Content-Type': 'text/html'});
	    var compiledtpl = _.template(tplsrc,{name:'guy',hobby:'fishing',count:cnt,pathname:pathname});
	    res.end(compiledtpl);
	    console.log('publishing on "'+pathname+'"');
	    client.publish(pathname,'incremented (to '+cnt+'!');
	}
			     );
    }
}).listen(8124, "127.0.0.1");



