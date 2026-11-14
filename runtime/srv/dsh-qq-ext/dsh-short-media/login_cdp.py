#!/usr/bin/env python3
"""Bounded administrator-only QR login; never registered as an agent tool."""
import asyncio,base64,json,os,signal,sys,time
from pathlib import Path
from cdp_reader import Page,PageNavigating,HOME,page_url,snapshot,migrate_once

async def login(site):
    assert site in ['xiaohongshu','douyin']
    HOME.mkdir(mode=0o700,exist_ok=True)
    status=HOME/(site+'-login-state.json');image=HOME/(site+'-login.png')
    def save(kind,**extra):
        status.write_text(json.dumps({'platform':site,'state':kind,'at':time.time(),**extra}));status.chmod(0o600)
        print(json.dumps({'platform':site,'state':kind,**extra},ensure_ascii=False),flush=True)
    save('opening')
    try:
        async with Page() as page:
            if site=='xiaohongshu':await migrate_once(page)
            await page.cdp.call('Page.navigate',{'url':page_url({'platform':site,'action':'status'})})
            deadline=time.monotonic()+120;clicked=False;shown=False
            while time.monotonic()<deadline:
                await asyncio.sleep(1)
                try:view=await snapshot(page,site,1)
                except PageNavigating:continue
                if view['network_restricted']:save('network_restricted');return
                if view['verification_required']:save('verification_required');return
                if view['logged_in']:save('logged_in');return
                try:
                    if not clicked:
                        clicked=bool(await page.cdp.evaluate("""(() => {
                      const e=[...document.querySelectorAll('button,[role=button],div,span')].find(e=>e.childElementCount===0&&e.innerText?.trim()==='登录'&&e.getBoundingClientRect().width>0);
                      if(e){e.click();return true;}return false;
                        })()"""))
                    ready=await page.cdp.evaluate("""!!document.querySelector('.login-container .qrcode-img, img[src*=qrcode], img[alt*=二维码], [class*=qrcode] canvas, [class*=qr-code] canvas') || /扫码登录|二维码登录|扫码后/.test(document.body?.innerText||'')""")
                except PageNavigating:continue
                if ready and not shown:
                    shot=await page.cdp.call('Page.captureScreenshot',{'format':'png','captureBeyondViewport':False})
                    image.write_bytes(base64.b64decode(shot['data']));image.chmod(0o600)
                    save('qr_ready',image=str(image));shown=True
                if not shown and deadline-time.monotonic()<95:
                    # A diagnostic image helps the owner distinguish a loading error
                    # from a QR prompt. It contains only this newly opened login page.
                    shot=await page.cdp.call('Page.captureScreenshot',{'format':'png','captureBeyondViewport':False})
                    image.write_bytes(base64.b64decode(shot['data']));image.chmod(0o600)
                    save('page_unavailable',image=str(image),visible_text_length=len(view['text']));return
            save('expired')
    except asyncio.CancelledError:save('cancelled');raise
    except Exception:save('failed');raise

async def main():
    loop=asyncio.get_running_loop();task=asyncio.current_task()
    for s in [signal.SIGTERM,signal.SIGINT]:loop.add_signal_handler(s,task.cancel)
    await login(sys.argv[1])

if __name__=='__main__':asyncio.run(main())
