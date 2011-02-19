_ = require('underscore');
fs = require('fs');
sys = require('sys');
http = require('http');
crypto = require('crypto');
redis = require('redis'),rd=redis.createClient(),ps=redis.createClient();
rd.on("error", function (err) {    console.log("Error " + err);});
ps.on("error", function (err) {    console.log("Error " + err);});
url = require('url');
io = require('socket.io');
console.log('loaded modules');

var gametpl = fs.readFileSync('rock_paper_scissors.html','utf-8');

var hometpl = fs.readFileSync('rock_paper_scissors_home.html','utf-8');
console.log('read templates');

function gencookie() 
{
    return crypto.
        createHash('md5').
        update("" + (new Date()).getTime()).
        digest("hex").slice(0,8);
}
function handle_request(req, res) 
{
    var urlp = url.parse(req.url)
    console.log('=>',urlp.pathname);
    if (urlp.pathname=='/') //homepage template
    {
	var ctpl = _.template(hometpl,{});
	console.log('handle_request:writeHead(200)');
	res.writeHead(200,{'Content-Type':'text/html'});
	res.end(ctpl);
    }
    else if (urlp.pathname=='/new_game') //new game instantiation & redirect
    {
	game_creation(req,res);
    }
    else if (/^\/([0-9a-f]{4})$/.exec(urlp.pathname))
    {
	var game_id = urlp.pathname.slice(1);
	render_game(game_id,req,res);
    }
    else { // (_.indexOf(['/favicon.ico'],urlp.pathname)!=-1) {    //404s
	console.log('writeHead(404) on ',urlp.pathname);
	res.writeHead(404,{'Content-Type':'text/html'});
	res.end('not found');
    }
}

function render_game(game_id,req,res)
{
    console.log('trying to get game',game_id);
    var dbtok = 'game:'+game_id;
    rd.get(dbtok,_.bind(render_game_obj,{req:req,res:res})); //retrieve the game object
}

function getauthcookie(rawcookie)
{
    if (!rawcookie) return null;
    var cookiearr  = _.map(rawcookie.split('; '),function(n) { return n.split('='); });
    var cookies = {} ; for (var i=0; i < cookiearr.length;i++) cookies[cookiearr[i][0]]=cookiearr[i][1];
    var authcookie = cookies['rps'];

    return authcookie;
}

function collect_game_tplvars(game,i_am)
{
    if (i_am=='spectator') {
	console.log('SPECTATOR HERE');
	//throw "no spectators allowed";
    }
    var tplvars = {gameid:game.id,role:i_am,options:['','rock','paper','scissors'],presence:game.presence};
    //load template vars depending on our role (p1,p2,spectator)

    if (game.p1sel) tplvars.p1moved=true;
    else tplvars.p1moved=false;
    if (game.p2sel) tplvars.p2moved=true;
    else tplvars.p2moved=false;

    tplvars.oponent_moved=false;
    if (i_am=='player1') 
    {
	tplvars.mysel = game.p1sel;
	if (game.p2sel) tplvars.oponent_moved=true;
    }
    else if (i_am=='player2') 
    {
	tplvars.mysel = game.p2sel;
	if (game.p1sel) tplvars.oponent_moved=true;
    }
    else tplvars.mysel=null;

    if (game.p2cookie) tplvars.players_present=2;
    else tplvars.players_present=1;

    tplvars.outcome = game.outcome;
    tplvars.ajax=false;
    return tplvars;
}
function render_game_obj(err,reply) 
{
    var req = this.req; var res = this.res;
    var game = JSON.parse(reply);
    console.log(sys.inspect(game));
    //cookie discovery
    //console.log('raw cookies are ',req.headers.cookie);
    //console.log('getauthcookie1 from ',req);
    var authcookie = getauthcookie(req.headers.cookie);

    console.log('user cookie is',authcookie);
    //based on the user's cookie we deduct his role
    var i_am='spectator'; var respond=true;
    if (authcookie == game.p1cookie) i_am='player1';
    else if (!game.p1cookie) throw "p1cookie is not set in game "+JSON.stringify(game);
    else if (!game.p2cookie) //player2 is just joining
    {
	i_am='player2';
	//we update the game to set the player's cookie and assign it to him
	var p2cookie = gencookie();
	var cb = _.bind(player2_signup,{res:res,p2cookie:p2cookie,game:game,i_am:i_am});
	console.log('player2 is joining. assigning new cookie for him ',p2cookie);
	updgame(game.id,{p2cookie:p2cookie},i_am,cb);
	respond=false; //no need to respond if we expect to be redirected by the callback.
    }
    else if (authcookie && (authcookie == game.p2cookie)) i_am='player2';

    if (respond)
    {
	var tplvars = collect_game_tplvars(game,i_am);
	//we can render the template now
	console.log('am ',i_am);
	var ctpl = _.template(gametpl,tplvars);
	console.log('render_game_obj:writeHead(200)');
	res.writeHead(200,{'Content-Type':'text/html'});
	res.end(ctpl);
    }
}
function publish_gamechange(game) 
{
    rd.publish('publish:'+game.id,JSON.stringify(game));	    
}
function player2_signup(err,ok) 
{
    var res = this.res; var p2cookie = this.p2cookie;
    console.log('player2_signup:setHeader(Set-Cookie[rps=])',p2cookie);
    res.setHeader("Set-Cookie",["rps="+p2cookie]);
    console.log('player2_signup::writeHead(302) redirect to /',this.game.id);
    res.writeHead(302, {
	'Location': '/'+this.game.id
    });
    res.end();
    publish_gamechange(this.game);

}

function game_creation(req,res) 
{
    //first, generate the new game token
    var game_id = crypto.
        createHash('md5').
        update("" + (new Date()).getTime()).
        digest("hex").slice(0,4);
    var p1cookie = gencookie();
    var gameobj = {id:game_id,p1cookie:p1cookie,p2cookie:null,stamp:new Date(),presence:{}};
    var dbtok = 'game:'+game_id;
    console.log('saving ',dbtok,'=',JSON.stringify(gameobj));
    gameobj.last_stamp = new Date(); gameobj.last_upd_by = 'player1';
    
    rd.set(dbtok,JSON.stringify(gameobj),function(err,ok) {
	if (ok=='OK')
	{
	    res.setHeader("Set-Cookie", ["rps="+p1cookie]);
	    res.writeHead(302, {
		'Location': '/'+game_id
	    });
	    res.end();
	    publish_gamechange(gameobj);
	}
    });
}

server = http.createServer(handle_request);
server.listen(8124, "127.0.0.1");


function updgame(gameid,cobj,updby,cb,nopublish)
{
    rd.get('game:'+gameid,function(err,obj) {
	game = JSON.parse(obj);
	for (k in cobj) 
	{
	    var pres = /^(.*)_present$/.exec(k);
	    if (pres)
	    {
		if (!game.presence) game.presence = {};
		game.presence[pres[1]]=cobj[k];
	    }
	    else
		game[k]=cobj[k];
	}
	if (updby)
	{
	    game.last_stamp = new Date(); game.last_upd_by = updby;
	}
	rd.set('game:'+game.id,JSON.stringify(game),function(err,ok) {
	    console.log('set value. yay. publishing game change',game);
	    //FIXME: potentially bad for concurrent moves - we are propagating OUR ver of the game object (which could have been changed by now)
	    if (!nopublish) publish_gamechange(game);
	    if (cb) cb(game);
	});
    });
}

function subscription_message(chan,msg) 
{
    var game = this.game; var client = this.client; var i_am = this.i_am;

    console.log('message published on channel',chan,':',msg);
    rd.get('game:'+game.id,function(err,obj) {
	/*//upon subscription, we mark the player as present
	var presence_key = i_am+'_present';
	var updo = {} ; updo[presence_key]=true;
	console.log( "marking presence of "+sys.inspect(updo));
	updgame(game.id,updo,null,function(obj) { //once we are done marking our presence, send the ajaxy gamediv to client 
	*/
	var obj = JSON.parse(obj);
	var tplvars = collect_game_tplvars(obj,i_am);
	console.log("responding with %o, %o",obj,i_am);
	tplvars.ajax=true;
	var gamediv = _.template(gametpl,tplvars);
	client.send(gamediv); //JSON.stringify({'op':'gamechange','gamediv':gamediv}));

	/*},true);*/
    });
}

// socket.io 
var socket = io.listen(server); 
socket.on('connection', function(client) { 
    //console.log('getauthcookie2 from ',client);
    //NO COOKIE PASSED?
    //var cook = getauthcookie(client.request);
    var game = null,gameid=null,i_am='spectator',subscription_bind=null,cook=null;
    //console.log(cook,'at',client.request.url);

    // new client is here! 
    client.on('message', function(msg){ 
	console.log('got message',msg);
	var d = JSON.parse(msg);
	if (d.op=='connect') //new client connecting, we fetch his game
	{
	    gameid = d.gameid;
	    var rawcookie = d.rawcookie;
	    cook = getauthcookie(rawcookie);
	    //fetch the game object into this bg connection client context
	    rd.get('game:'+gameid,function(err,obj) {
		console.log('rd.get(%o)',obj);
		game = JSON.parse(obj);
		if (cook == game.p1cookie) i_am='player1';
		else if (cook == game.p2cookie) i_am='player2';
		//looks like we are in a game. let's subscribe to the redis channel to get news on this game:

		var presence_key = i_am+'_present';
		var updo = {} ; updo[presence_key]=true;
		console.log( "marking presence of "+sys.inspect(updo));
		//lets let our presence be known.

		updgame(game.id,updo,null,function(obj) { //once we are done marking our presence, send the ajaxy gamediv to client 
		    
		    console.log('ATTACHING SUBS MESSAGE ARRIVAL EVENT');
		    //we remember this function because we later have to unsubscribe and unset once client disconnects
		    subscription_bind = _.bind(subscription_message,{game:game,client:client,i_am:i_am});
		    ps.on('message',subscription_bind);
		    console.log('SUBSCRIBE',game.id);
		    ps.subscribe('publish:'+game.id);
		},false);
	    });
	    //if we get a subscription notice, act upon it and tell the client to update its gamestate

	}
	else if (d.op=='selval' && game && !game.outcome) //if move is made and game exists and not over
	{
	    console.log('player made a selection',d);
	    //make sure that player is authorized.
	    if (cook == game.p1cookie) { updgame(game.id,{p1sel:d.val},i_am); }
	    else if (cook == game.p2cookie) { updgame(game.id,{p2sel:d.val},i_am); }
	    else throw "unauthorized attempt to move in game "+game.id+' by '+cook;
	}
	else throw "dunno what to do with msg "+msg;
    }); 
    client.on('disconnect', function(){
	var presence_key = i_am+'_present';
	var updo = {} ; updo[presence_key]=false;
	console.log( "disconnecting from "+gameid+". marking presence of "+sys.inspect(updo));
	updgame(gameid,updo,null,function(obj) { //once we are done marking our presence, send the ajaxy gamediv to client 
	    console.log('UNSUBSCRIBE',game.id);
	    ps.unsubscribe('publish:'+game.id); 
	    ps.removeListener('message',subscription_bind);
	},false);
	
	//console.log('got disco; unsubscribed from ',game.id);
    }); 
}); 


