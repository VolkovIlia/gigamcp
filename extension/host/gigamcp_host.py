#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Помощник GigaMCP для локальных MCP-программ (stdio).

Браузер сам запускает этот скрипт через Native Messaging, когда расширению нужен
локальный сервер, например `wordcraft-cli mcp`. Помощник запускает программу и
передаёт сообщения между ней и расширением. Только стандартная библиотека Python 3.6+,
права администратора не нужны.

Протокол с расширением (JSON, 4 байта длины + тело):
  → {"type": "hello"}                                   ← {"type": "hello", "version", "python"}
  → {"type": "spawn", "command", "args", "env", "cwd"}  ← {"type": "spawned", "pid"} | {"type": "error", "message"}
  → {"type": "msg", "data": <JSON-RPC>}                 ← {"type": "msg", "data": <JSON-RPC>}
                                                        ← {"type": "chunk", "id", "i", "n", "part"} (крупные ответы)
                                                        ← {"type": "log", "line"} (stderr программы)
                                                        ← {"type": "exit", "code", "stderr"}
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import threading

VERSION = '0.2.0'
MAX_FRAME = 900 * 1024      # Chrome принимает от помощника не больше 1 МБ за сообщение
CHUNK_CHARS = 150 * 1000    # с запасом на экранирование и UTF-8

_out_lock = threading.Lock()
_chunk_id = [0]
_stderr_tail = []


def send(obj):
    data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    if len(data) > MAX_FRAME and obj.get('type') == 'msg':
        text = json.dumps(obj['data'], ensure_ascii=False)
        parts = [text[i:i + CHUNK_CHARS] for i in range(0, len(text), CHUNK_CHARS)]
        _chunk_id[0] += 1
        for i, part in enumerate(parts):
            send({'type': 'chunk', 'id': _chunk_id[0], 'i': i, 'n': len(parts), 'part': part})
        return
    with _out_lock:
        sys.stdout.buffer.write(struct.pack('<I', len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack('<I', raw)
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode('utf-8'))


def find_command(cmd):
    """Ищет программу в PATH и в типичных пользовательских папках (браузер может запустить нас с коротким PATH)."""
    if os.path.sep in cmd or (os.name == 'nt' and ('\\' in cmd or ':' in cmd)):
        return os.path.expanduser(cmd)
    home = os.path.expanduser('~')
    extra = [os.path.join(home, p) for p in ('.local/bin', 'bin', '.cargo/bin', '.npm-global/bin', '.deno/bin', '.bun/bin')]
    extra += ['/usr/local/bin', '/opt/homebrew/bin', '/snap/bin']
    path = os.pathsep.join([os.environ.get('PATH', '')] + extra)
    return shutil.which(cmd, path=path) or cmd


def pump_stdout(proc):
    for line in iter(proc.stdout.readline, b''):
        line = line.strip()
        if not line:
            continue
        try:
            send({'type': 'msg', 'data': json.loads(line.decode('utf-8'))})
        except ValueError:
            send({'type': 'log', 'line': line.decode('utf-8', 'replace')[:2000]})


def pump_stderr(proc):
    for line in iter(proc.stderr.readline, b''):
        text = line.decode('utf-8', 'replace').rstrip()
        if text:
            _stderr_tail.append(text)
            del _stderr_tail[:-20]
            send({'type': 'log', 'line': text[:2000]})


def main():
    proc = None
    while True:
        try:
            msg = read_message()
        except Exception as e:  # повреждённый кадр
            send({'type': 'error', 'message': 'Ошибка чтения сообщения: %s' % e})
            break
        if msg is None:  # расширение закрыло соединение
            break
        kind = msg.get('type')
        if kind == 'hello':
            send({'type': 'hello', 'version': VERSION, 'python': sys.version.split()[0], 'platform': sys.platform})
        elif kind == 'spawn':
            if proc is not None:
                send({'type': 'error', 'message': 'Программа уже запущена'})
                continue
            command = msg.get('command') or ''
            args = [str(a) for a in (msg.get('args') or [])]
            env = dict(os.environ)
            env.update({str(k): str(v) for k, v in (msg.get('env') or {}).items()})
            cwd = os.path.expanduser(msg.get('cwd') or '') or None
            exe = find_command(command)
            try:
                proc = subprocess.Popen([exe] + args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env, cwd=cwd, bufsize=0)
            except OSError as e:
                send({'type': 'error', 'message': 'Не удалось запустить «%s»: %s. Укажите полный путь к программе.' % (command, e.strerror or e)})
                proc = None
                continue
            threading.Thread(target=pump_stdout, args=(proc,), daemon=True).start()
            threading.Thread(target=pump_stderr, args=(proc,), daemon=True).start()

            def wait_exit(p):
                code = p.wait()
                send({'type': 'exit', 'code': code, 'stderr': '\n'.join(_stderr_tail[-5:])})
                os._exit(0)
            threading.Thread(target=wait_exit, args=(proc,), daemon=True).start()
            send({'type': 'spawned', 'pid': proc.pid, 'path': exe})
        elif kind == 'msg':
            if proc is None:
                send({'type': 'error', 'message': 'Программа не запущена'})
                continue
            try:
                proc.stdin.write((json.dumps(msg.get('data'), ensure_ascii=False) + '\n').encode('utf-8'))
                proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
        elif kind == 'kill':
            break
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()


if __name__ == '__main__':
    main()
