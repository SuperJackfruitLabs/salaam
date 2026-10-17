"""Disposable real PTY, controlled over JSON lines; never automates a user's terminal app."""
import os, sys, pty, subprocess, termios, fcntl, struct, signal, select, json, base64, time

spec = json.loads(sys.argv[1])
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', spec.get('rows', 32), spec.get('columns', 100), 0, 0))
def child_session():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
p = subprocess.Popen(spec['argv'], stdin=slave, stdout=slave, stderr=slave, cwd=spec.get('cwd'), env=os.environ.copy(), preexec_fn=child_session)
paused = False
stopping = False
incoming = b''
def attributes():
    # macOS revokes the slave's ioctls when its controlling session leader exits.
    # The master still exposes the same PTY line discipline for restoration checks.
    try: return termios.tcgetattr(slave)
    except termios.error: return termios.tcgetattr(master)

def send(value):
    sys.stdout.write(json.dumps(value) + '\n')
    sys.stdout.flush()
send({'type': 'ready', 'pid': p.pid, 'tty': os.ttyname(slave)})
try:
    while True:
        ready, _, _ = select.select([sys.stdin.buffer] + ([] if paused else [master]), [], [], .025)
        if master in ready:
            try:
                data = os.read(master, 65536)
                if data: send({'type': 'data', 'data': base64.b64encode(data).decode()})
            except OSError:
                pass
        if sys.stdin.buffer in ready:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                stopping = True
                break
            incoming += chunk
            while b'\n' in incoming:
                line, incoming = incoming.split(b'\n', 1)
                command = json.loads(line)
                op = command['op']
                if op == 'write':
                    data = base64.b64decode(command['data'])
                    while data:
                        count = os.write(master, data)
                        data = data[count:]
                elif op == 'resize':
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', command['rows'], command['columns'], 0, 0))
                    if p.poll() is None: os.killpg(p.pid, signal.SIGWINCH)
                elif op == 'signal':
                    if p.poll() is None: os.killpg(p.pid, getattr(signal, command['signal']))
                elif op == 'pause': paused = bool(command['paused'])
                elif op == 'status': pass
                else: raise ValueError('Unknown terminal operation')
                send({'type': 'ack', 'id': command['id'], 'restored': attributes() == before, 'raw': not bool(attributes()[3] & termios.ICANON)})
        if p.poll() is not None:
            paused = False
            while select.select([master], [], [], 0)[0]:
                try:
                    data = os.read(master, 65536)
                    if not data: break
                    send({'type': 'data', 'data': base64.b64encode(data).decode()})
                except OSError: break
            send({'type': 'exit', 'code': p.returncode, 'restored': attributes() == before})
            break
finally:
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
        try: p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
    os.close(master)
    os.close(slave)
