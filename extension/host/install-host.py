#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Установка помощника GigaMCP для локальных MCP-программ — для текущего пользователя, без прав администратора.

    python3 install-host.py              # установить для всех найденных браузеров
    python3 install-host.py --uninstall  # удалить
    python3 install-host.py --browser-dir ПАПКА  # явно указать папку профиля браузера (для тестов)
    python3 install-host.py --extension-id ID    # разрешить ещё и копию GigaMCP с другим ID (из магазина)

Кладёт gigamcp_host.py в ~/.local/share/gigamcp (Windows: %LOCALAPPDATA%\\GigaMCP) и регистрирует
его в браузерах на базе Chromium: Chrome, Chromium, Яндекс Браузер, Edge, Brave, Vivaldi, Opera.
Браузеры из Flatpak получают обёртку, которая запускает помощник вне песочницы (flatpak-spawn --host),
и разрешение на это: flatpak override --user --talk-name=org.freedesktop.Flatpak.

Файл из релиза содержит помощник внутри (HOST_SOURCE), поэтому его можно запустить без папки расширения:
    curl -fsSL https://github.com/VolkovIlia/gigamcp/releases/download/vX.Y.Z/install-host.py | python3 -
"""
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys

NAME = 'ru.gigamcp.host'
EXTENSION_IDS = ['mmjnppnijhblimofghdejjdhfgdjgcol']
HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser('~')
HOST_SOURCE = None  # scripts/pack.sh подставляет сюда gigamcp_host.py для файла из релиза

LINUX_DIRS = ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'yandex-browser',
              'yandex-browser-beta', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'vivaldi', 'opera']
MAC_DIRS = ['Google/Chrome', 'Google/Chrome Beta', 'Chromium', 'Yandex/YandexBrowser', 'Microsoft Edge',
            'BraveSoftware/Brave-Browser', 'Vivaldi']
WIN_KEYS = [r'Software\Google\Chrome', r'Software\Chromium', r'Software\Yandex\YandexBrowser',
            r'Software\Microsoft\Edge', r'Software\BraveSoftware\Brave-Browser']
# Flatpak: идентификатор приложения → папка профиля внутри ~/.var/app/<id>/config
FLATPAK_APPS = [('org.chromium.Chromium', 'chromium'),
                ('io.github.ungoogled_software.ungoogled_chromium', 'chromium'),
                ('com.google.Chrome', 'google-chrome'),
                ('com.microsoft.Edge', 'microsoft-edge'),
                ('com.brave.Browser', 'BraveSoftware/Brave-Browser'),
                ('com.vivaldi.Vivaldi', 'vivaldi'),
                ('com.opera.Opera', 'opera')]
FLATPAK_TALK = '--talk-name=org.freedesktop.Flatpak'


def manifest(path):
    return {
        'name': NAME,
        'description': 'GigaMCP: запуск локальных MCP-программ',
        'path': path,
        'type': 'stdio',
        'allowed_origins': ['chrome-extension://%s/' % i for i in EXTENSION_IDS],
    }


def write_manifest(folder, path):
    """Пишет манифест; ID расширений из прежнего манифеста сохраняются (распакованная копия и копия из магазина)."""
    os.makedirs(folder, exist_ok=True)
    mpath = os.path.join(folder, NAME + '.json')
    m = manifest(path)
    try:
        with open(mpath, encoding='utf-8') as f:
            old = json.load(f).get('allowed_origins') or []
    except (OSError, ValueError, AttributeError):
        old = []
    m['allowed_origins'] += [o for o in old if o not in m['allowed_origins']]
    with open(mpath, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=2)


def make_executable(path):
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def target_dir():
    if os.name == 'nt':
        return os.path.join(os.environ.get('LOCALAPPDATA', HOME), 'GigaMCP')
    return os.path.join(HOME, '.local', 'share', 'gigamcp')


def host_source():
    if HOST_SOURCE:
        return HOST_SOURCE
    try:
        with open(os.path.join(HERE, 'gigamcp_host.py'), encoding='utf-8') as f:
            return f.read()
    except OSError:
        sys.exit('Рядом нет gigamcp_host.py. Запустите install-host.py из папки host расширения '
                 'или скачайте его со страницы релиза: https://github.com/VolkovIlia/gigamcp/releases')


def install_files():
    d = target_dir()
    os.makedirs(d, exist_ok=True)
    host = os.path.join(d, 'gigamcp_host.py')
    src = host_source()
    if os.name == 'nt':
        with open(host, 'w', encoding='utf-8') as f:
            f.write(src)
        bat = os.path.join(d, 'gigamcp_host.bat')
        with open(bat, 'w', encoding='utf-8') as f:
            f.write('@echo off\r\n"%s" -u "%s" %%*\r\n' % (sys.executable, host))
        return d, bat
    # шебанг на конкретный интерпретатор: браузер может запустить нас с урезанным PATH
    with open(host, 'w', encoding='utf-8') as f:
        f.write('#!%s -u\n' % sys.executable + src.split('\n', 1)[1])
    make_executable(host)
    return d, host


def browser_dirs(explicit):
    if explicit:
        return [os.path.join(explicit, 'NativeMessagingHosts')]
    if sys.platform == 'darwin':
        base = os.path.join(HOME, 'Library', 'Application Support')
        return [os.path.join(base, b, 'NativeMessagingHosts') for b in MAC_DIRS if os.path.isdir(os.path.join(base, b))]
    base = os.environ.get('XDG_CONFIG_HOME') or os.path.join(HOME, '.config')
    found = [os.path.join(base, b, 'NativeMessagingHosts') for b in LINUX_DIRS if os.path.isdir(os.path.join(base, b))]
    # Chrome и Chromium ставим всегда: папка могла ещё не появиться
    for b in ('google-chrome', 'chromium'):
        p = os.path.join(base, b, 'NativeMessagingHosts')
        if p not in found:
            found.append(p)
    return found


def flatpak_browsers(explicit):
    """(id, профиль, папка манифестов, обёртка) для установленных Flatpak-браузеров. Их песочница видит только ~/.var/app/<id>."""
    if explicit or os.name == 'nt' or sys.platform == 'darwin':
        return []
    out = []
    for app, profile in FLATPAK_APPS:
        root = os.path.join(HOME, '.var', 'app', app)
        if os.path.isdir(root):
            pdir = os.path.join(root, 'config', profile)
            out.append((app, pdir, os.path.join(pdir, 'NativeMessagingHosts'),
                        os.path.join(root, 'data', 'gigamcp', 'gigamcp_host.sh')))
    return out


def has_gigamcp(pdir):
    """Стоит ли GigaMCP в каком-нибудь профиле браузера (Default, Profile N…). Папки появляются сразу после установки,
    а Preferences браузер дописывает позже, поэтому он — запасной признак."""
    try:
        users = [os.path.join(pdir, u) for u in os.listdir(pdir)]
    except OSError:
        return False
    for u in users:
        for ext_id in EXTENSION_IDS:
            if any(os.path.isdir(os.path.join(u, sub, ext_id)) for sub in ('Extensions', 'Local Extension Settings')):
                return True
        for name in ('Preferences', 'Secure Preferences'):
            try:
                with open(os.path.join(u, name), encoding='utf-8', errors='replace') as f:
                    text = f.read()
            except OSError:
                continue
            if any(ext_id in text for ext_id in EXTENSION_IDS):
                return True
    return False


def flatpak_override(app, flag):
    """Меняет разрешение песочницы; при неудаче возвращает команду, которую нужно выполнить вручную."""
    cmd = ['flatpak', 'override', '--user', flag, app]
    try:
        ok = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    except OSError:
        ok = False
    return None if ok else ' '.join(cmd)


def install(explicit):
    d, exe = install_files()
    done = []
    if os.name == 'nt':
        import winreg
        mpath = os.path.join(d, NAME + '.json')
        write_manifest(d, exe)
        for key in WIN_KEYS:
            k = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key + '\\NativeMessagingHosts\\' + NAME)
            winreg.SetValueEx(k, '', 0, winreg.REG_SZ, mpath)
            winreg.CloseKey(k)
            done.append('HKCU\\' + key)
    else:
        for bd in browser_dirs(explicit):
            write_manifest(bd, exe)
            done.append(bd)
    granted, manual, skipped = [], [], []
    for app, pdir, bd, wrapper in flatpak_browsers(explicit):
        os.makedirs(os.path.dirname(wrapper), exist_ok=True)
        with open(wrapper, 'w', encoding='utf-8') as f:
            f.write('#!/bin/sh\n# Помощник GigaMCP запускается вне песочницы Flatpak, чтобы видеть программы компьютера\n'
                    'exec flatpak-spawn --host %s -u %s "$@"\n' % (shlex.quote(sys.executable), shlex.quote(exe)))
        make_executable(wrapper)
        write_manifest(bd, wrapper)
        done.append(bd)
        # разрешение выводит браузер из песочницы, поэтому выдаём его только там, где стоит GigaMCP
        if not has_gigamcp(pdir):
            skipped.append('flatpak override --user %s %s' % (FLATPAK_TALK, app))
            continue
        cmd = flatpak_override(app, FLATPAK_TALK)
        if cmd:
            manual.append(cmd)
        else:
            granted.append(app)
    print('Помощник GigaMCP установлен: %s' % exe)
    print('Зарегистрирован в:')
    for x in done:
        print('  • ' + x)
    if manual:
        print('\nНе удалось разрешить Flatpak-браузеру запускать помощник. Выполните:')
        for c in manual:
            print('  ' + c)
    if skipped:
        print('\nВ этих Flatpak-браузерах GigaMCP не найден, разрешение не выдано. Если поставите расширение туда, выполните:')
        for c in skipped:
            print('  ' + c)
    if granted or manual:
        print('\nБраузер из Flatpak (%s): закройте его полностью и откройте снова — новое разрешение '
              'действует после перезапуска. Затем в панели MCP нажмите «Проверить помощник».'
              % ', '.join(granted + [c.rsplit(' ', 1)[1] for c in manual]))
    else:
        print('\nПерезапускать браузер не нужно. В панели MCP нажмите «Проверить помощник».')


def uninstall(explicit):
    if os.name == 'nt':
        import winreg
        for key in WIN_KEYS:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key + '\\NativeMessagingHosts\\' + NAME)
            except OSError:
                pass
    else:
        for bd in browser_dirs(explicit):
            p = os.path.join(bd, NAME + '.json')
            if os.path.exists(p):
                os.remove(p)
    revoke = []
    for app, _, bd, wrapper in flatpak_browsers(explicit):
        for p in (os.path.join(bd, NAME + '.json'), wrapper):
            if os.path.exists(p):
                os.remove(p)
        revoke.append('flatpak override --user --no-talk-name=org.freedesktop.Flatpak ' + app)
    shutil.rmtree(target_dir(), ignore_errors=True)
    print('Помощник GigaMCP удалён.')
    if revoke:
        print('Разрешение Flatpak-браузеру оставлено: им могут пользоваться другие программы. Отозвать:')
        for c in revoke:
            print('  ' + c)


if __name__ == '__main__':
    argv = sys.argv[1:]
    explicit = argv[argv.index('--browser-dir') + 1] if '--browser-dir' in argv else None
    if sys.version_info < (3, 6):
        sys.exit('Нужен Python 3.6 или новее')
    if '--extension-id' in argv:  # копия из магазина получает свой ID; панель расширения передаёт его в команде
        ext_id = argv[argv.index('--extension-id') + 1] if argv.index('--extension-id') + 1 < len(argv) else ''
        if not re.fullmatch('[a-p]{32}', ext_id):
            sys.exit('Неверный ID расширения: %r' % ext_id)
        if ext_id not in EXTENSION_IDS:
            EXTENSION_IDS.append(ext_id)
    (uninstall if '--uninstall' in argv else install)(explicit)
