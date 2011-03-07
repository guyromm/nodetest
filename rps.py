#this code was kindly ported and contributed by traviscline of irc://freenode/#gevent
from gevent import monkey; monkey.patch_all()
from gevent_zeromq import zmq
#import zmq
import gevent
import redis
import time,json
import hashlib
from flask import Flask, render_template, request, redirect, g, url_for
from flaskext.redis import Redis
from socketio import SocketIOServer


#config options
PORT = 8124

#from werkzeug import generate_password_hash, check_password_hash
app = Flask(__name__)
app.config.from_object(__name__)

app.config.from_pyfile('flask_rps.cfg') #['DEBUG']=True
#app.debug = True
r = Redis(app)
nowhex = lambda : hashlib.md5(str(time.time())).hexdigest()

def get_game(game_id):
    gp = 'game:%s:' % game_id
    gamefields = ['p1cookie','p2cookie','player1_present','player2_present','stamp','last_stamp','last_upd_by','p1sel','p2sel','outcome','rematch'];
    keys = [gp+field for field in gamefields]
    values = g.redis.mget(keys)
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
    print g.redis.mset(values)
    
    return game_id

@app.route('/')
def home():
    return render_template('rock_paper_scissors_home.html')

@app.route('/new_game')
def new_game():
    p1cookie = nowhex()[:8]
    game_id = get_new_game_id(p1cookie=p1cookie)
    response = redirect(url_for('game', game_id=game_id))
    response.set_cookie('rps', p1cookie)
    return response

if app.config['DEBUG']:
    from werkzeug import SharedDataMiddleware
    import os
    app.wsgi_app = SharedDataMiddleware(app.wsgi_app, {
      '/': os.path.join(os.path.dirname(__file__), 'static')
    })

@app.route('/<game_id>')
def game(game_id):
    game = get_game(game_id)

    authcookie = request.cookies.get('rps',None)

    print 'game', game
    print 'cookie:', authcookie
    
    i_am = 'spectator'
    respond = True

    if authcookie == game['p1cookie']:
        i_am = 'player1'
    elif authcookie == game['p2cookie']:
        i_am = 'player2'
    
    context = game
    context.update({
        'gameid':game_id,
        'i_am': i_am,
        'ajax': request.is_xhr,
        'gamedivsrc': render_template('rock_paper_scissors_gamediv.html')
    })

    return render_template('rock_paper_scissors.html', **context)

def html(s):
    return '&quot;'.join('&gt;'.join('&lt;'.join('&amp;'.join(s.split('&')).split( '<')).split('>')).split('"'))

def getauthcookie(rawcookie):
    if not rawcookie: return None
    cookiearr  = [ck.split('=') for ck in rawcookie.split('; ')]
    cookies = {}
    for ck in cookiearr:
        cookies[ck[0]]=ck[1]
    authcookie = cookies['rps'];

    return authcookie

@app.route('/socket.io/websocket')
def socketio():
    s = request.environ['socketio']
    if s.on_connect():
        print 'CONNECTED'
        #s.send({'buffer': buffer})
        #s.broadcast({'announcement': s.session.session_id + ' connected'})
        pass

    game_id=None
    game=None
    cook=None
    i_am='spectator'
    
    context = zmq.Context()
    
    zmq_sub_socket = context.socket(zmq.SUB)
    zmq_sub_socket.connect ("ipc://rps.events.ipc")
    
    zmq_pub_socket = context.socket(zmq.PUB)
    zmq_pub_socket.bind("ipc://rps.events.ipc")

    def handle_socketio_connection(socketio_connection, pubsock,subsock):
        print 'HANDLE_SOCKETIO'
        while True:
            messages = socketio_connection.recv()
            
            for msg in messages:
                dt = json.loads(msg)
                print 'GOT MSG %s'%dt
                if dt['op']=='connect':
                    game_id = dt['gameid']
                    cook = getauthcookie(dt['rawcookie'])
                    game = get_game(game_id)
                    if cook == game['p1cookie']: i_am='player1'
                    elif cook == game['p2cookie']:  i_am='player2'
                    pubkey = 'publish:'+game_id
                    print 'subscribing to game %s'%pubkey
                    subsock.setsockopt_unicode(zmq.SUBSCRIBE, pubkey)
                    print 'received connect on game %s, with auth cook %s. i am %s'%(game_id,cook,i_am)
    
                elif dt['op']=='send_chat':
                    pubkey = 'publish:'+game_id
                    pmsg = json.dumps({'op':'chat','user':i_am,'text':html(dt['text'])})
                    print 'sending pub on %s : %s'%(pubkey,pmsg)
                    pubsock.send_unicode(pubkey+';;;;'+pmsg)

                else:
                    raise Exception(dt)
    def handle_subscription_listener():
        print 'LISTENING' 
        while True:
            print 'RECIEVING'
            recv = zmq_sub_socket.recv()
            dt = json.loads(recv.split(';;;;')[1])
            print 'RECEIVED %s'%dt
            s.send(json.dumps({'op':'chat','user':dt['user'],'text':dt['text']}))
    gevent.spawn(handle_subscription_listener)
    handle_socketio_connection(s,zmq_pub_socket,zmq_sub_socket)
    #return gevent.joinall([gevent.spawn(handle_subscription_listener),gevent.spawn(handle_socketio_connection,s,zmq_pub_socket,zmq_sub_socket)])
    # return gevent.joinall([
    #     #gevent.spawn(handle_redis_subscription, g.redis, s),
    #     gevent.spawn(handle_socketio_connection, s, zmq_pub_socket,zmq_sub_socket),
    #     ])


if __name__ == '__main__':
    print 'Listening on port %s and on port 843 (flash policy server)' % app.config['PORT']
    SocketIOServer(('', app.config['PORT']), app.wsgi_app, resource="socket.io").serve_forever()
    #app.run(port=PORT)

