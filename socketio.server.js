var http = require('http'),  
io = require('socket.io'),
fs = require('fs');

respcont = fs.readFileSync('socketio.client.js');


server = http.createServer(function(req, res){ 
 // your normal server code 
    res.writeHead(200, {'Content-Type': 'text/html'}); 
    res.end(respcont);
});
server.listen(8080);
  
// socket.io 
var socket = io.listen(server); 
socket.on('connection', function(client){ 
    console.log('welcome, new client');
  // new client is here! 
    client.send('wilkommen');
    client.on('message', function(msg){ console.log('message arrived',msg); }) 
    client.on('disconnect', function(){ console.log('disconnected'); }) 
}); 
