#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Установка помощника GigaMCP для локальных MCP-программ — для текущего пользователя, без прав администратора.

    python3 install-host.py              # установить для всех найденных браузеров
    python3 install-host.py --uninstall  # удалить
    python3 install-host.py --browser-dir ПАПКА  # явно указать папку профиля браузера (для тестов)

Копирует gigamcp_host.py в ~/.local/share/gigamcp (Windows: %LOCALAPPDATA%\\GigaMCP) и регистрирует
его в браузерах на базе Chromium: Chrome, Chromium, Яндекс Браузер, Edge, Brave, Vivaldi, Opera.
"""
import json
import os
import shutil
import stat
import sys

NAME = 'ru.gigamcp.host'
EXTENSION_IDS = ['mmjnppnijhblimofghdejjdhfgdjgcol']
HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser('~')

LINUX_DIRS = ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'yandex-browser',
              'yandex-browser-beta', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'vivaldi', 'opera']
MAC_DIRS = ['Google/Chrome', 'Google/Chrome Beta', 'Chromium', 'Yandex/YandexBrowser', 'Microsoft Edge',
            'BraveSoftware/Brave-Browser', 'Vivaldi']
WIN_KEYS = [r'Software\Google\Chrome', r'Software\Chromium', r'Software\Yandex\YandexBrowser',
            r'Software\Microsoft\Edge', r'Software\BraveSoftware\Brave-Browser']


def manifest(path):
    return {
        'name': NAME,
        'description': 'GigaMCP: запуск локальных MCP-программ',
        'path': path,
        'type': 'stdio',
        'allowed_origins': ['chrome-extension://%s/' % i for i in EXTENSION_IDS],
    }


def target_dir():
    if os.name == 'nt':
        return os.path.join(os.environ.get('LOCALAPPDATA', HOME), 'GigaMCP')
    return os.path.join(HOME, '.local', 'share', 'gigamcp')


def install_files():
    d = target_dir()
    os.makedirs(d, exist_ok=True)
    host = os.path.join(d, 'gigamcp_host.py')
    shutil.copyfile(os.path.join(HERE, 'gigamcp_host.py'), host)
    if os.name == 'nt':
        bat = os.path.join(d, 'gigamcp_host.bat')
        with open(bat, 'w', encoding='utf-8') as f:
            f.write('@echo off\r\n"%s" -u "%s" %%*\r\n' % (sys.executable, host))
        return d, bat
    # шебанг на конкретный интерпретатор: браузер может запустить нас с урезанным PATH
    with open(host, 'r', encoding='utf-8') as f:
        src = f.read().split('\n', 1)[1]
    with open(host, 'w', encoding='utf-8') as f:
        f.write('#!%s -u\n' % sys.executable + src)
    os.chmod(host, os.stat(host).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
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


def install(explicit):
    d, exe = install_files()
    m = manifest(exe)
    done = []
    if os.name == 'nt':
        import winreg
        mpath = os.path.join(d, NAME + '.json')
        with open(mpath, 'w', encoding='utf-8') as f:
            json.dump(m, f, ensure_ascii=False, indent=2)
        for key in WIN_KEYS:
            k = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key + '\\NativeMessagingHosts\\' + NAME)
            winreg.SetValueEx(k, '', 0, winreg.REG_SZ, mpath)
            winreg.CloseKey(k)
            done.append('HKCU\\' + key)
    else:
        for bd in browser_dirs(explicit):
            os.makedirs(bd, exist_ok=True)
            with open(os.path.join(bd, NAME + '.json'), 'w', encoding='utf-8') as f:
                json.dump(m, f, ensure_ascii=False, indent=2)
            done.append(bd)
    print('Помощник GigaMCP установлен: %s' % exe)
    print('Зарегистрирован в:')
    for x in done:
        print('  • ' + x)
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
    shutil.rmtree(target_dir(), ignore_errors=True)
    print('Помощник GigaMCP удалён.')


if __name__ == '__main__':
    argv = sys.argv[1:]
    explicit = argv[argv.index('--browser-dir') + 1] if '--browser-dir' in argv else None
    if sys.version_info < (3, 6):
        sys.exit('Нужен Python 3.6 или новее')
    (uninstall if '--uninstall' in argv else install)(explicit)
