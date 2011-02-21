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

var gametpl = fs.readFileSync('rock_paper_scissors.html'     ,'utf-8');
var gamedivtpl = fs.readFileSync('./static/rock_paper_scissors_gamediv.html','utf-8');
var hometpl = fs.readFileSync('rock_paper_scissors_home.html','utf-8');

console.log('read templates');

function html(s) { return s.split('&').join('&amp;').split( '<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;') }

function gencookie() 
{
    return crypto.
        createHash('md5').
        update("" + (new Date()).getTime()).
        digest("hex").slice(0,8);
}

function static_file_serve(staticres,res) 
{
    var realpath = './static/'+staticres[1];
    fs.stat(realpath,function(err,stats) {
	if (err) 	{
	    res.writeHead(404,{'Content-Type':'text/html'});
	    res.end('file not found '+urlp.path);
	}
	else
	{
	    var ftypes = {'js':'text/javascript','html':'text/html'};
	    var suffixres = /\.([a-z]+)$/.exec(realpath);
	    if (suffixres && ftypes[suffixres[1]]) var ftype = ftypes[suffixres[1]];
	    else ftype='text/plain';
	    //console.log('got stats on file',err,sys.inspect(stats));
	    res.writeHead(200,{'Content-Type':ftype});
	    fs.readFile(realpath,function(err,data) {
		res.end(data);
	    });
	}
    });
}

function handle_request(req, res) 
{
    var urlp = url.parse(req.url)
    var staticres;

    console.log('=>',urlp.pathname);
    if (urlp.pathname=='/') //homepage template
    {
	var ctpl = _.template(hometpl,{});
	console.log('handle_request:writeHead(200)');
	res.writeHead(200,{'Content-Type':'text/html'});
	res.end(ctpl);
    }
    else if ((staticres = /^\/static\/(.*)$/.exec(urlp.pathname))) // adhoc static file serving from ./static. highly naive :P
    {
	static_file_serve(staticres,res);
    }
    else if (urlp.pathname=='/new_game') //new game instantiation & redirect
	game_creation(res);
    else if (/^\/([0-9a-f]{4})$/.exec(urlp.pathname)) //existing game 
    {
	var game_id = urlp.pathname.slice(1);
	render_game(game_id,req,res);
    }
    else 
    { // 404
	console.log('writeHead(404) on ',urlp.pathname);
	res.writeHead(404,{'Content-Type':'text/html'});
	res.end('not found');
    }
}

function get_game(game_id,cb) 
{
    var m = rd.multi();
    var gp = 'game:'+game_id+':';
    var gamefields = ['p1cookie','p2cookie','player1_present','player2_present','stamp','last_stamp','last_upd_by','p1sel','p2sel','outcome','rematch'];
    _.each(gamefields,function(fn) {
	m.get(gp+fn);
    });
    m.exec(function(err,replies) {
	var obj = {};
	for (var fi=0;fi<gamefields.length;fi++)
	{
	    var pres = /^(.*)_present$/.exec(gamefields[fi]);
	    if (pres)
	    {
		if (!obj.presence) obj.presence = {};
		obj.presence[pres[1]]=replies[fi];
	    }
	    else
		obj[gamefields[fi]]=replies[fi];
	}
	obj.id = game_id;
	cb(obj);
    });

}
function render_game(game_id,req,res)
{
    get_game(game_id,_.bind(render_game_obj,{req:req,res:res}));
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
    //console.log('collect_game_tplvars()',game,i_am);
    var tplvars = {gameid:game.id,role:i_am,options:['','rock','paper','scissors'],presence:game.presence,outcome:game.outcome,rematch:game.rematch};
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
    //console.log('TPLVARS:',sys.inspect(tplvars))
    return tplvars;
}
function render_gamediv(tplvars)
{

    var gdctpl = _.template(gamedivtpl,tplvars);

    var tplv = {};
    _.extend(tplv,tplvars,{gamediv:gdctpl,gamedivsrc:gamedivtpl});

    var ctpl = _.template(gametpl,tplv);
    return ctpl;
}
function render_game_obj(game) 
{
    var req = this.req; var res = this.res;
    //console.log(sys.inspect(game));
    //cookie discovery
    //console.log('raw cookies are ',req.headers.cookie);
    //console.log('getauthcookie1 from ',req);
    var authcookie = getauthcookie(req.headers.cookie);

    console.log('user cookie is',authcookie);
    //based on the user's cookie we deduct his role
    var i_am='spectator'; var respond=true;
    if (authcookie == game.p1cookie) i_am='player1';
    else if (!game.p1cookie) 
    {
	console.log("p1cookie is not set in game "+JSON.stringify(game));
	i_am='player1';
	//we update the game to set the player's cookie and assign it to him
	var p1cookie = gencookie();
	var cb = _.bind(player_signup,{res:res,cookie:p1cookie,game:game,i_am:i_am});
	console.log(i_am,' is joining. assigning new cookie for him ',p1cookie);
	updgame(game.id,{p1cookie:p1cookie,player1_present:true},i_am,cb);
	respond=false; //no need to respond if we expect to be redirected by the callback.

    }
    else if (!game.p2cookie) //player2 is just joining
    {
	i_am='player2';
	//we update the game to set the player's cookie and assign it to him
	var p2cookie = gencookie();
	var cb = _.bind(player_signup,{res:res,cookie:p2cookie,game:game,i_am:i_am});
	console.log('player2 is joining. assigning new cookie for him ',p2cookie);
	updgame(game.id,{p2cookie:p2cookie,player2_present:true},i_am,cb);
	respond=false; //no need to respond if we expect to be redirected by the callback.
    }
    else if (authcookie && (authcookie == game.p2cookie)) i_am='player2';
    console.log('i am determined',i_am);
    if (respond)
    {
	var tplvars = collect_game_tplvars(game,i_am);
	//we can render the template now
	console.log('am ',i_am);
	var ctpl = render_gamediv(tplvars);
	console.log('render_game_obj:writeHead(200)');
	res.writeHead(200,{'Content-Type':'text/html'});
	res.end(ctpl);
    }
}
function publish_gamechange(game_id) 
{
    console.log('publish_gamechange()',game_id);
    get_game(game_id,function(game) { 
	console.log('HITTING publish button'); //,game);
	rd.publish('publish:'+game_id,JSON.stringify(game)); 
    });
    //rd.publish('publish:'+game_id,'game changed'); //JSON.stringify(game));	    
}
function player_signup(err,ok) 
{
    var res = this.res; var ck = this.cookie;
    console.log('player_signup:setHeader(Set-Cookie[rps=])',ck);
    res.setHeader("Set-Cookie",["rps="+ck]);
    console.log('player_signup::writeHead(302) redirect to /',this.game.id);
    res.writeHead(302, {
	'Location': '/'+this.game.id
    });
    res.end();
    publish_gamechange(this.game);

}

function game_creation(res,cb) 
{
    //first, generate the new game token
    var game_id = crypto.
        createHash('md5').
        update("" + (new Date()).getTime()).
        digest("hex").slice(0,4);
    var gp = 'game:'+game_id+':';
    if (res)
	var p1cookie = gencookie();
    var gamestamp = new Date();
    //set several vars in a multifashion
    var m = rd.multi();
    m.set(gp+'stamp',gamestamp);
    if (res)
	m.set(gp+'p1cookie',p1cookie);
    m.set(gp+'last_stamp',gamestamp);
    m.set(gp+'last_upd_by','player1');
    m.set(gp+'player1_present',true);

    m.exec(function(err,replies) {
	var unq = _.uniq(replies);
	if (unq.length==1 && unq[0]=='OK')
	{
	    if (res)
	    {
		res.setHeader("Set-Cookie", ["rps="+p1cookie]);
		res.writeHead(302, {
		    'Location': '/'+game_id
		});
		res.end();
		publish_gamechange(game_id);
	    }
	    else if (cb)
	    {
		console.log('returning game id + p1cookie via cb',game_id,p1cookie);
		cb(game_id);
	    }
	}
	else
	{
	    console.log(replies);
	    throw "game creation failed?";
	}

    });

}

server = http.createServer(handle_request);
server.listen(8124, "0.0.0.0");


function updgame(gameid,cobj,updby,cb,nopublish)
{
    if (!gameid) throw "invalid gameid passed";
    var gp = 'game:'+gameid+':';

    var m = rd.multi();
    for (k in cobj) m.set(gp+k,cobj[k]);
    
    if (updby) m.set(gp+'last_upd_by',updby);
    m.exec(function(err,replies) {
	var unq = _.uniq(replies);
	if (unq.length==1 && unq[0]=='OK')
	{
	    //see if we have to play the game out
	    get_game(gameid,function(gobj)  {
		if (gobj.p1sel && gobj.p2sel && !gobj.outcome)
		{

		    var outcome;
		    if (gobj.p1sel=='scissors' && gobj.p2sel=='rock') outcome='player2_victory';
		    else if (gobj.p1sel=='rock' && gobj.p2sel=='paper') outcome='player2_victory';
		    else if (gobj.p1sel=='paper' && gobj.p2sel=='scissors') outcome='player2_victory';
		    else if (gobj.p2sel=='scissors' && gobj.p1sel=='rock') outcome='player1_victory';
		    else if (gobj.p2sel=='rock' && gobj.p1sel=='paper') outcome='player1_victory';
		    else if (gobj.p2sel=='paper' && gobj.p1sel=='scissors') outcome='player1_victory';
		    else if (gobj.p1sel==gobj.p2sel) outcome='draw';
		    else throw "unknown combo "+gobj.p1sel+","+gobj.p2sel;
		    console.log("PLAYING OUT OUTCOME ",outcome);
		    updgame(gameid,{outcome:outcome},updby,cb,nopublish);
		}
		else
		{
		    if (!nopublish) {
			console.log('PUB GAMECHANGE');
			publish_gamechange(gameid);
		    }
		    if (cb) get_game(gameid,cb);
		}
	    });

	}
	else
	{
	    console.log(replies);
	    throw "updgame failed?";
	}
    });

}

function subscription_message(chan,msg) 
{
    console.log('MESSAGE IN on',chan);
    var pubgameid = /^publish\:(.*)$/.exec(chan)[1];
    var game = this.game; var client = this.client; var i_am = this.i_am;
    if (game.id !=pubgameid)
    {
	console.log("CHANNEL MISMATCH #@$%@#$^",game.id,pubgameid);
	return;
    }
    //console.log('about to parse ',msg);
    var obj = JSON.parse(msg);
    if (obj.op=='chat')
    {
	client.send(JSON.stringify({'op':'chat','user':obj.user,'text':obj.text}));
    }
    else
    {
	var tplvars = collect_game_tplvars(obj,i_am);
	//console.log("responding with %o, %o",obj,i_am);
	client.send(JSON.stringify({'op':'gamechange','tplvars':tplvars}));
    }
    
/*    tplvars.ajax=true;
    var gamediv = render_gamediv(tplvars); 
    client.send(gamediv); //JSON.stringify({'op':'gamechange','gamediv':gamediv}));*/
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
	//console.log('got message',msg);
	var d = JSON.parse(msg);
	if (d.op=='connect') //new client connecting, we fetch his game
	{
	    //console.log('op is connect',d);
	    gameid = d.gameid;
	    var rawcookie = d.rawcookie;
	    cook = getauthcookie(rawcookie);
	    //fetch the game object into this bg connection client context
	    get_game(gameid,function(obj) {
		game = obj;
		//console.log('gotten game',game);
		if (cook == game.p1cookie) i_am='player1';
		else if (cook == game.p2cookie) i_am='player2';
		//looks like we are in a game. let's subscribe to the redis channel to get news on this game:

		var presence_key = i_am+'_present';
		var updo = {} ; updo[presence_key]=true;
		console.log( "marking presence of "+sys.inspect(updo));
		//lets let our presence be known.

		updgame(game.id,updo,null,function(obj) { //once we are done marking our presence, send the ajaxy gamediv to client 

		    //we remember this function because we later have to unsubscribe and unset once client disconnects
		    subscription_bind = _.bind(subscription_message,{game:game,client:client,i_am:i_am});
		    console.log('SUBSCRIBE',game.id);
		    ps.subscribe('publish:'+game.id);
		    console.log('ATTACHING SUBS MESSAGE ARRIVAL EVENT');
		    ps.on('message',subscription_bind);

		},false);
	    });
	    //if we get a subscription notice, act upon it and tell the client to update its gamestate

	}
	else if (d.op=='selval' && game && !game.outcome) //if move is made and game exists and not over
	{
	    //get up to date game obj to make sure we have no outcome done
	    get_game(game.id,function(nobj) {
		console.log('player made a selection',d,'while game outcome is ',nobj.outcome);
		if (nobj.outcome) { console.log('not playing with outcome'); return; }
		//make sure that player is authorized.
		if (cook == game.p1cookie) { updgame(game.id,{p1sel:d.val},i_am); }
		else if (cook == game.p2cookie) { updgame(game.id,{p2sel:d.val},i_am); }
		else throw "unauthorized attempt to move in game "+game.id+' by '+cook;
	    });
	}
	else if (d.op=='offer_rematch')
	{
	    get_game(gameid,function(nobj) {
		if (!nobj.rematch && nobj.outcome) {
		    game_creation(null,function(ngame_id) {
			updgame(game.id,{rematch:ngame_id},i_am,function(ngm) {
			    client.send(JSON.stringify({'op':'rematch_created','game_id':ngame_id}));
			});
		    });
		}
	    });
	}
	else if (d.op=='send_chat')
	{
	    console.log('broadcasting chat on ',gameid);
	    rd.publish('publish:'+gameid,JSON.stringify({'op':'chat','user':i_am,'text':html(d.text)}));
	}
	else throw "dunno what to do with msg "+msg+' with game '+sys.inspect(game);
    }); 
    client.on('disconnect', function(){
	var presence_key = i_am+'_present';
	var updo = {} ; updo[presence_key]=false;
	if (gameid)
	{
	    console.log( "disconnecting from "+gameid+". marking presence of "+sys.inspect(updo));
	    updgame(gameid,updo,null,function(obj) { //once we are done marking our presence, send the ajaxy gamediv to client 
		//after experimentation it was found that it is not nescessary to unsubscribe from the redis event but to avoid dupes remove the previous listener for the bind to subscription
		console.log('UNSUBSCRIBE',gameid);
		//ps.unsubscribe('publish:'+gameid); 
		ps.removeListener('message',subscription_bind);
	    },false);
	}
	else
	    console.log('STRANGE: disconnect occured from session without gameid');
	//console.log('got disco; unsubscribed from ',game.id);
    }); 
}); 



