"""Fetch only manifest-listed, pinned official ST files into the ignored SDK directory.

No hardware access. No existing mismatched file is overwritten. Network/cache
files and retrieved third-party sources are not part of the public repository.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib,io,json,urllib.request,zipfile

ROOT=Path(__file__).resolve().parent
LOCK=json.loads((ROOT/'dependency-lock.json').read_text(encoding='utf8'))
FILES=json.loads((ROOT/'dependency-files.sha256.json').read_text(encoding='utf8'))
def sha(data):return hashlib.sha256(data).hexdigest()
def get(url):
    with urllib.request.urlopen(url,timeout=45) as response:return response.read()
def match_bytes(data,expected):
    for candidate in (data,data.replace(b'\r\n',b'\n'),data.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n')):
        if sha(candidate)==expected:return candidate
    raise ValueError('Official source bytes do not match the pinned manifest; nothing was overwritten.')

def main():
    dependency_root=ROOT/'third_party';dependency_root.mkdir(exist_ok=True)
    dependency_root=dependency_root.resolve();destinations={}
    # Establish directories serially before worker threads resolve Windows paths.
    # Every manifest entry must remain a plain relative path below third_party.
    for relative in FILES:
        item=Path(relative)
        if item.is_absolute() or '..' in item.parts or item.parts[0]!='third_party':raise ValueError('Unsafe dependency manifest path.')
        destination=dependency_root.joinpath(*item.parts[1:]);destination.parent.mkdir(parents=True,exist_ok=True)
        destination=destination.resolve()
        if not destination.is_relative_to(dependency_root):raise ValueError('Dependency path escaped its root.')
        destinations[relative]=destination
    archives={}
    for name in ('hal','cmsis_device'):
        item=LOCK[name];repo=item['repository'].removeprefix('https://github.com/')
        archive=zipfile.ZipFile(io.BytesIO(get(f'https://codeload.github.com/{repo}/zip/{item["commit"]}')))
        prefix=archive.namelist()[0].split('/')[0]+'/'
        archives[name]=(archive,prefix)
    def fetch(item):
        relative,expected=item;destination=destinations[relative]
        if destination.exists():
            if sha(destination.read_bytes())!=expected:raise ValueError('Existing dependency differs; left untouched.')
            return
        data=None
        for name in ('hal','cmsis_device'):
            prefix=LOCK[name]['path']+'/'
            if relative.startswith(prefix):
                archive,zprefix=archives[name];data=archive.read(zprefix+relative[len(prefix):]);break
        if data is None:
            baseline=LOCK['baseline'];prefix=baseline['path']+'/'
            if not relative.startswith(prefix+'Drivers/CMSIS/Include/'):raise ValueError('Unknown manifest component.')
            repository=baseline['repository'].removeprefix('https://github.com/')
            data=get(f'https://raw.githubusercontent.com/{repository}/{baseline["commit"]}/{relative[len(prefix):]}')
        data=match_bytes(data,expected)
        destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(data)
    with ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(fetch,FILES.items()))
    print(json.dumps({'ok':True,'pinned_official_files_verified':len(FILES),'hardware_accessed':False}))

if __name__=='__main__':main()
