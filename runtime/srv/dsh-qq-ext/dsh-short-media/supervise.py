#!/usr/bin/env python3
"""Bounded, single-worker supervisor. It owns only the descendants it starts."""
import os,signal,subprocess,sys,time,tempfile,re,urllib.request
from pathlib import Path

def process_table():
    table={}
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:
            f=(p/'stat').read_text().rsplit(')',1)[1].split()
            table[int(p.name)]={'parent':int(f[1]),'start':f[19],'rss':int(f[21])*os.sysconf('SC_PAGE_SIZE')}
        except (OSError,ValueError,IndexError):pass
    return table

def main():
    # Configuration is fixed by our launcher; caller cannot raise these limits.
    lifetime=150 if sys.argv[1]=='login' else 42
    argv=sys.argv[2:];assert argv and Path(argv[0]).is_absolute()
    stopped=[];tracked={}
    for s in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(s,lambda sig,_f:stopped.append(sig))
    env=os.environ.copy()
    for k in ['OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS']:env[k]='1'
    fd,receipt=tempfile.mkstemp(prefix='paopao-browser-tab-');os.close(fd)
    env['SHORT_MEDIA_TAB_RECEIPT']=receipt
    child=subprocess.Popen(argv,env=env,start_new_session=True)
    start=time.monotonic();reason=None
    try:
        while child.poll() is None:
            table=process_table()
            known={child.pid}|set(tracked)
            for _ in range(8):
                new={pid for pid,v in table.items() if v['parent'] in known}
                if new<=known:break
                known|=new
            for pid in known:
                if pid in table:tracked.setdefault(pid,table[pid]['start'])
            total=0
            for pid,identity in list(tracked.items()):
                if pid not in table or table[pid]['start']!=identity:continue
                try:
                    # PSS counts shared browser pages once instead of double-counting RSS.
                    total+=next(int(l.split()[1])*1024 for l in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines() if l.startswith('Pss:'))
                except (OSError,StopIteration):total+=table[pid]['rss']
            available=next(int(l.split()[1])*1024 for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
            if stopped:reason='cancelled'
            elif time.monotonic()-start>lifetime:reason='timeout'
            elif total>320*1024*1024 or available<160*1024*1024:reason=f'memory pressure (worker PSS={total//1048576} MiB, available={available//1048576} MiB)'
            if reason:break
            time.sleep(.1)
        if reason:
            print('[short-media] stopped: '+reason,file=sys.stderr);return 124
        return child.returncode
    finally:
        # Verify start ticks before every signal to avoid touching a reused PID.
        for sig in [signal.SIGTERM,signal.SIGKILL]:
            table=process_table()
            for pid,identity in reversed(list(tracked.items())):
                if pid in table and table[pid]['start']==identity:
                    try:os.kill(pid,sig)
                    except ProcessLookupError:pass
            try:os.killpg(child.pid,sig)
            except ProcessLookupError:pass
            if sig==signal.SIGTERM:time.sleep(1)
        child.wait(timeout=3)
        # The shared browser is not our child. Close only our receipt's target,
        # including after an uncooperative worker was forcibly killed.
        try:
            target=Path(receipt).read_text().strip()
            if re.fullmatch(r'[A-Fa-f0-9]{32}',target):
                urllib.request.urlopen('http://127.0.0.1:9222/json/close/'+target,timeout=2).close()
        except OSError:pass
        finally:Path(receipt).unlink(missing_ok=True)

if __name__=='__main__':raise SystemExit(main())
