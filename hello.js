var http = require('http');
var cnt=0;
http.createServer(function (req, res) {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end('Hello <b>World</b> '+cnt+'\n');
    cnt++;
    //console.log('cnt increment %o',cnt);
}).listen(8124, "127.0.0.1");
console.log('Server running at http://127.0.0.1:8124/');