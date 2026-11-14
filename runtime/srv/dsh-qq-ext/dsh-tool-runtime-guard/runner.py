#!/usr/bin/env python3
"""A small resource supervisor for chat shell tools, not a security sandbox.

No dependencies, no chat/config access. Children stay in a dedicated process
group. Memory pressure, CPU, wall timeout, cancellation and parent exit all
terminate that group, including ordinary background descendants.
"""
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

MIB=1024*1024

def available_bytes():
    for line in Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):return int(line.split()[1])*1024
    raise RuntimeError('MemAvailable unavailable')

def usage(pgid):
    rss=0;cpu=0;members=[]
    page=os.sysconf('SC_PAGE_SIZE');ticks=os.sysconf('SC_CLK_TCK')
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:
            # comm may contain spaces and parentheses; fields after its final ')'.
            fields=(p/'stat').read_text().rsplit(')',1)[1].split()
            if int(fields[2])!=pgid:continue
            members.append(int(p.name));rss+=int(fields[21])*page
            cpu+=(int(fields[11])+int(fields[12]))/ticks
        except (FileNotFoundError,ProcessLookupError,PermissionError):continue
    return rss,cpu,members

def run(command,wall=45,rss_limit=320*MIB,min_available=160*MIB,cpu_limit=30):
    if available_bytes()<min_available:
        print('[tool-runtime] 内存不足，暂不启动命令',file=sys.stderr);return 125
    env=os.environ.copy()
    for k in ['OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS']:
        env[k]='1'
    def prepare():
        os.nice(10)
        # Under extreme pressure prefer reclaiming this worker, not the chat host.
        try:Path('/proc/self/oom_score_adj').write_text('500')
        except OSError:pass
    stopped=[]
    def request_stop(sig,_frame):stopped.append(sig)
    old={s:signal.signal(s,request_stop) for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP)}
    proc=None;reason=None;start=time.monotonic()
    try:
        proc=subprocess.Popen(['/bin/bash','-c',command],env=env,start_new_session=True,preexec_fn=prepare)
        while proc.poll() is None:
            memory,cpu,_=usage(proc.pid)
            if stopped:reason='cancelled'
            elif time.monotonic()-start>=wall:reason='wall timeout'
            elif memory>rss_limit:reason='worker memory limit'
            elif available_bytes()<min_available:reason='host memory pressure'
            elif cpu>cpu_limit:reason='worker CPU budget'
            if reason:break
            time.sleep(.05)
        if reason:
            print('[tool-runtime] stopped: '+reason,file=sys.stderr)
            return 124 if reason=='wall timeout' else 125
        return proc.returncode if proc.returncode>=0 else 128-proc.returncode
    finally:
        if proc is not None:
            try:os.killpg(proc.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            # Reap the shell, but do not confuse shell exit with descendant exit.
            deadline=time.monotonic()+.5
            while time.monotonic()<deadline:
                proc.poll()
                if not usage(proc.pid)[2]:break
                time.sleep(.025)
            try:os.killpg(proc.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            proc.wait(timeout=1)
        for s,handler in old.items():signal.signal(s,handler)

if __name__=='__main__':
    if len(sys.argv)!=3 or sys.argv[1]!='--':raise SystemExit('usage: runner.py -- COMMAND')
    raise SystemExit(run(sys.argv[2]))
