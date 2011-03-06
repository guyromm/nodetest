#this code was kindly ported and contributed by traviscline of irc://freenode/#gevent
import time
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
    authcookie = request.cookies['rps']

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
        'i_am': i_am,
        'ajax': request.is_xhr,
        'gamedivsrc': render_template('rock_paper_scissors_gamediv.html')
    })

    return render_template('rock_paper_scissors.html', **context)

@app.route('/socket.io')
def socketio():
    s = request.environ['socketio']
    if s.on_connect():
        print 'connected', locals()
        #s.send({'buffer': buffer})
        #s.broadcast({'announcement': s.session.session_id + ' connected'})

    while True:
        message = s.recv()

        if len(message) == 1:
            message = message[0]
            message = {'message': [s.session.session_id, message]}
            buffer.append(message)
            if len(buffer) > 15:
                del buffer[0]
            s.broadcast(message)
        else:
            if not s.connected():
                s.broadcast({'announcement': s.session.session_id + ' disconnected'})
                break


if __name__ == '__main__':
    print 'Listening on port %s and on port 843 (flash policy server)' % app.config['PORT']
    SocketIOServer(('', app.config['PORT']), app.wsgi_app, resource="socket.io").serve_forever()
    #app.run(port=PORT)

