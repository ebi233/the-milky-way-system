"""Review images in an isolated maintenance room; no changes to owner chat or routing."""
import sys,json,pathlib
sys.path.insert(0,'/srv/dsh-qq-ext/dsh-persona-integrity')
from maintenance_room import review
if __name__=='__main__':
    image,message,output=map(pathlib.Path,sys.argv[1:4])
    result=review(message.read_text(),None if image.name=='no-image' else image)
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False))
