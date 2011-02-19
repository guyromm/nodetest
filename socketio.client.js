<html>
<body>
<script src="/socket.io/socket.io.js"></script> 
<script> 
    var socket = new io.Socket('localhost',{port:8080,rememberTransport:true,timeout:1500});
 socket.connect();
socket.on('connect', function(){ console.log('connected to server'); socket.send('hi there, this is a test message'); }) 
socket.on('message', function(msg){ console.log('recieved a message!',msg); socket.send('danke, danke!'); }) 
socket.on('disconnect', function(){ console.log('disconnected from server'); }) 
</script> 
</body>
</html>