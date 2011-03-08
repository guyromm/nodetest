#!/usr/bin/python
from gevent import monkey; monkey.patch_all()
import gevent,json,redis,hashlib,time,re
from mako.template import Template
from mako.runtime import Context
from StringIO import StringIO

from geventwebsocket.handler import WebSocketHandler
from gevent_zeromq import zmq

#redis connection
r = redis.Redis('localhost')

#templates
tpls = {}
for tn,fn in {'home':'templates/rock_paper_scissors_home.html'
           ,'gamediv':'templates/rock_paper_scissors_gamediv.html'
           ,'rps':'templates/rock_paper_scissors.html'}.items():
    tpls[tn] = Template(filename=fn,module_directory='cache')
    
#game helper routines
nowhex = lambda : hashlib.md5(str(time.time())).hexdigest()

#we use one socket to publish
context = zmq.Context()
zmq_pub_socket = context.socket(zmq.PUB)
zmq_pub_socket.bind("ipc://rps.events.ipc")

def get_game(game_id):
    gp = 'game:%s:' % game_id
    gamefields = ['p1cookie','p2cookie','player1_present','player2_present','stamp','last_stamp','last_upd_by','p1sel','p2sel','outcome','rematch'];
    keys = [gp+field for field in gamefields]
    values = r.mget(keys)
    game = dict(zip(gamefields, values))
    game['presence'] = {
        'player1': bool(game.get('player1_present')),
        'player2': bool(game.get('player2_present')),
    }
    game['id'] = game_id
    return game

def get_new_game_id(**extra_keys):
    """this returns a new game id from a salted timestamp"""
    game_id = nowhex()[:4]
    gp = 'game:%s:' % game_id
    gamestamp = time.time()
    
    values = {
        gp+'stamp': gamestamp,
        gp+'last_stamp': gamestamp,
        gp+'last_upd_by': 'player1',
        gp+'player1_present': True,
    }
    for key, value in extra_keys.items():
        values[gp+key] = value

    print 'setting values with prefix', gp
    print r.mset(values)
    
    return game_id

def updgame(gameid,values,i_am=None):
    gp = 'game:%s:'%gameid
    nvals = {}
    for k,v in values.items():
        nvals[gp+k]=v
    if i_am:
        nvals[gp+'last_upd_by']=i_am
    nvals[gp+'last_stamp']=time.time()
    print 'UPDGAME %s with %s'%(gameid,values)
    r.mset(nvals)
    chstr = json.dumps({'op':'gamechange','game':get_game(gameid)})
    zmq_pub_socket.send_unicode(u'%s;;;;%s'%(gameid,chstr))
    
def html(s):
    return '&quot;'.join('&gt;'.join('&lt;'.join('&amp;'.join(s.split('&')).split( '<')).split('>')).split('"'))

def getauthcookie(rawcookie):
    if not rawcookie: return None
    cookiearr  = [ck.split('=') for ck in rawcookie.split('; ')]
    cookies = {}
    for ck in cookiearr:
        if len(ck)>1:
            cookies[ck[0]]=ck[1]
    authcookie = cookies['rps'];

    return authcookie



gamere = re.compile('^\/([0-9a-f]{4})$')
websocketre = re.compile('^\/websocket/([0-9a-f]{4})$')

def get_tplvars(game_id,i_am,game):
    rt= {
        'gameid':game_id,
        'role': i_am,
        'ajax': False, #request.is_xhr,
        'presence':[],
        'options':['','rocks','paper','scissors'],
        'outcome':game['outcome'],
        'rematch':game['rematch']
        }
    rt['oponent_moved']=False
    if i_am =='player1':
        rt['mysel']=game['p1sel']
        if game['p2sel']: rt['oponent_moved']=True
    elif i_am == 'player2':
        rt['mysel']=game['p2sel']
        if game['p1sel']: rt['oponent_moved']=True
    else: rt['mysel']=None
    return rt

def hello_world(env, start_response):
    gameres = gamere.search(env['PATH_INFO'])
    websocketres = websocketre.search(env['PATH_INFO'])
    
    if gameres:
        game_id = gameres.group(1)
        start_response('200 OK', [('Content-Type', 'text/html')])
        game = get_game(game_id)
        authcookie = getauthcookie('HTTP_COOKIE' in env and env['HTTP_COOKIE'] or None)
        print 'auth cookie is %s'%authcookie
        print 'game', game
        print 'cookie:', authcookie

        i_am = 'spectator'
        respond = True

        if authcookie == game['p1cookie']:
            i_am = 'player1'
        elif authcookie == game['p2cookie']:
            i_am = 'player2'


        tplvars = get_tplvars(game_id,i_am,game)
        
        buf = StringIO()
        ctx = Context(buf,**tplvars)
        #for tplk,tplv in tplvars.items(): setattr(ctx,tplk,tplv)
        tpls['gamediv'].render_context(ctx)
        gamediv = buf.getvalue()

        tplvars['gamediv'] = gamediv
        buf = StringIO() ; ctx = Context(buf,**tplvars)
        ctx.gamedivsrc='<!--DISABLED-->' #gamedivsrc

        tpls['rps'].render_context(ctx)
        return buf.getvalue()
    elif env['PATH_INFO'].split('/')[1]=='static' and '..' not in env['PATH_INFO']:
        print 'STATIC %s'%env['PATH_INFO']
        if re.compile('\.js$').search(env['PATH_INFO']):
            start_response('200 OK', [('Content-Type', 'text/javascript')])
        else:
            raise Exception('unknown doc')
        with open(env['PATH_INFO'][1:]) as jfn:
            return jfn.read()
    elif env['PATH_INFO'] == '/':
        start_response('200 OK', [('Content-Type', 'text/html')])
        return tpls['home'].render(data={})
    elif env['PATH_INFO']=='/new_game':
        p1cookie = nowhex()[:8]
        game_id = get_new_game_id(p1cookie=p1cookie)
        start_response('302 Found',[('Location','/%s'%game_id),('Set-Cookie','rps=%s'%p1cookie)])
        return 'redirecting to game %s'%game_id
    elif websocketres:
        data = {'gameid':websocketres.group(1)
                ,'game':get_game(websocketres.group(1))
                ,'cook':None
                ,'i_am':'spectator'}
        #= getauthcookie('HTTP_COOKIE' in env and env['HTTP_COOKIE'] or None)
        #raise Exception(env)
        print 'INCOMING WEBSOCKET game %s.'%(data['gameid'])
        zmq_sub_socket = context.socket(zmq.SUB)
        zmq_sub_socket.connect ("ipc://rps.events.ipc")


        start_response('200 OK',[('Content-Type','application/json')])
        ws = env["wsgi.websocket"]

        def websocket_handler(ws,zmq_pub_socket):
            zmq_sub_socket.setsockopt_unicode(zmq.SUBSCRIBE,unicode(data['gameid'])) #we take all messages for now
            while True:
                message = ws.wait()
                print 'message %s arrived'%message
                if message:
                    d = json.loads(message)
                    if d['op']=='send_chat':
                        d['user']=data['i_am']
                        zmq_pub_socket.send_unicode(u'%s;;;;%s'%(data['gameid'],json.dumps(d)))
                        print 'published the message %s'%message
                    elif d['op']=='connect':
                        assert data['gameid']==d['gameid']
                        cook = data['cook'] = getauthcookie(d['rawcookie'])
                        if (cook == data['game']['p1cookie']): data['i_am']='player1'
                        elif (cook == data['game']['p2cookie']): data['i_am']='player2'
                        updgame(data['gameid'],{"%s_present"%data['i_am']:True})
                        #r.set('game:%s:%s_present'%(data['gameid'],data['i_am'],True))
                        
                        print 'ASSIGNED GAME ID via cookie %s; role is %s'%(cook,data['i_am'])
                    elif d['op']=='selval':
                        tgm = get_game(data['gameid'])
                        if tgm['outcome']:
                            print 'outcome already set. cancelling'
                        else:
                            if cook == tgm['p1cookie']: updgame(data['gameid'],{'p1sel':d['val']},data['i_am'])
                            elif cook == tgm['p2cookie']: updgame(data['gameid'],{'p2sel':d['val']},data['i_am'])
                            else: raise Exception( "unauthorized attempt to move in game "+data['gameid']+' by '+cook)
                else:
                    updgame(data['gameid'],{"%s_present"%data['i_am']:False})
                    print 'received None in ws.wait(); breaking conn.'
                    #TODO: unsubscribe from game in 0mq 
                    break
                #ws.send(message)

        def zmq_sub_handler(ws,zmq_sub_socket):
            while True:
                print 'looping on zmq sub socket recv'
                recv = zmq_sub_socket.recv()
                gameid,recv = recv.split(';;;;')
                print 'json parsing %s'%recv
                o = json.loads(recv)
                if o['op']=='send_chat':
                    ws.send(json.dumps(o))
                    print 'SENT CHAT on %s to %s'%(gameid,data['i_am'])
                else:
                    assert gameid==data['gameid']
                    game = get_game(gameid)
                    print 'SUBSCRIPTION RECV for %s:  %s'%(gameid,recv)
                    buf = StringIO()
                    tplvars = get_tplvars(gameid,data['i_am'],game)
                    ctx = Context(buf,**tplvars)
                    tpls['gamediv'].render_context(ctx)
                    gamediv = buf.getvalue()
                    ws.send(json.dumps({'op':'gamechange','game':recv,'atpl':gamediv}))
                    print 'SENT GAMECHANGE on %s to %s'%(gameid,data['i_am'])
                ws.send(json.dumps({'op':'noop'})) #noop is a workaround for likely buffered input on the client's websocket
        print 'instantiating gevent greenlets'
        gevent.joinall([gevent.spawn(websocket_handler,ws,zmq_pub_socket),gevent.spawn(zmq_sub_handler,ws,zmq_sub_socket)])
        print 'JOINED ALL'
    else:
        start_response('404 Not Found', [('Content-Type', 'text/html')])
        return ['<h1>Not Found</h1>']

print 'Serving on 8088...'
gevent.pywsgi.WSGIServer(('', 8088), hello_world,handler_class=WebSocketHandler).serve_forever()
                                    
