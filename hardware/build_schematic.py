"""Generate a local EasyEDA Pro V3 archive from the documented official example.

No vendor library/cloud edits. These symbols describe finished module interfaces,
not the on-board electronics. Pin numbers are documentation-verified candidates;
delivered-board identity and connector orientation remain unverified.
"""
from pathlib import Path
import json, zipfile, hashlib, html
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'eda'
OUT.mkdir(exist_ok=True)
def doc_uuid(name):
    """Stable 16-hex document identity; CONFIG keeps its singleton name."""
    return name if name == 'CONFIG' else hashlib.sha256(('fieldnote:'+name).encode()).hexdigest()[:16]
CLIENT = doc_uuid('active-inspection-local')
BUILD_TIMESTAMP_MS = int(datetime.now(timezone.utc).timestamp() * 1000)
lines, docs = [], []
ticket = 0
def emit(kind, data, id=None):
    global ticket
    ticket += 1
    head = {'type':kind,'ticket':ticket}
    if id is not None: head['id'] = id
    lines.append(json.dumps(head,separators=(',',':'))+'||'+json.dumps(data,ensure_ascii=False,separators=(',',':'))+'|')
def doc(kind, uuid):
    docs.append((kind,uuid))
    emit('DOCHEAD', {'docType':kind,'client':CLIENT,'uuid':uuid,
        'updateTime':BUILD_TIMESTAMP_MS,'version':str(BUILD_TIMESTAMP_MS),'user':{'uuid':uuid}})
def attr(parent,key,value,x=0,y=0,visible=False,part=''):
    emit('ATTR',dict(partId=part,groupId='',locked=False,zIndex=1,parentId=parent,key=key,value=value,keyVisible=False,valueVisible=visible,x=x,y=y,rotation=0,color=None,fillColor=None,fontFamily='Arial',fontSize=8,strikeout=False,underline=False,italic=False,fontWeight=False,align='LEFT_MIDDLE',version='2.0'),f'a{ticket}')
def text(value,x,y,size=10):
    emit('TEXT',dict(groupId='',locked=False,zIndex=3,x=x,y=y,rotation=0,value=value,color='#283B47',fillColor=None,fontFamily='Arial',fontSize=size,strikeout=False,underline=False,italic=False,fontWeight=False,align='LEFT_MIDDLE',version='2.0'),f't{ticket}')

modules = [
    {'ref':'U1','name':'NUCLEO-F401RE / reference only','x':120,'y':-180,'pins':[
        ('CN10-21','PA9 / TX USART1','UART_F4_TX','OUT'),('CN10-33','PA10 / RX USART1','UART_F4_RX','IN'),
        ('CN10-13','PA6 / PAN TIM3 CH1','PAN_PWM','OUT'),('CN10-15','PA7 / TILT TIM3 CH2','TILT_PWM','OUT'),
        ('CN10-9','GND / Signal ground','GND','BI'),('USB_VBUS','USB connector +5V / see JP1 note','NUCLEO_5V','IN')]},
    {'ref':'U2','name':'ESP32-P4-NANO / C6 + OV5647','x':520,'y':-180,'pins':[
        ('P1-15','GPIO21 / UART RX','UART_F4_TX','IN'),
        ('P1-13','GPIO20 / UART TX','UART_F4_RX','OUT'),
        ('P1-25','GND / Signal ground','GND','BI'),('USB_VBUS','Type-C connector +5V','P4_5V','IN')]},
    {'ref':'M1','name':'Pan servo / prewired plug','x':120,'y':-460,'pins':[
        ('SIGNAL','Control input','PAN_PWM','IN'),('VPLUS','Separate 5V supply','SERVO_5V','IN'),('GND','Return / signal ground','GND','BI')]},
    {'ref':'M2','name':'Tilt servo / prewired plug','x':520,'y':-460,'pins':[
        ('SIGNAL','Control input','TILT_PWM','IN'),('VPLUS','Separate 5V supply','SERVO_5V','IN'),('GND','Return / signal ground','GND','BI')]},
    {'ref':'P1','name':'NUCLEO USB supply / finished','x':120,'y':-670,'pins':[
        ('USB_5V','Fixed 5V >=1A','NUCLEO_5V','OUT'),('GND','USB return','GND','BI')]},
    {'ref':'P2','name':'P4 USB supply / finished','x':520,'y':-670,'pins':[
        ('USB_5V','Fixed 5V >=3A','P4_5V','OUT'),('GND','USB return','GND','BI')]},
    {'ref':'P3','name':'Servo supply / finished','x':920,'y':-670,'pins':[
        ('PLUS','Fixed 5V >=3A','SERVO_5V','OUT'),('MINUS','Cable return','GND','BI')]},
]
netlist = {}
for m in modules:
    sym, dev, part = 'sym_'+m['ref'], 'dev_'+m['ref'], 'part_'+m['ref']
    height = max(80,len(m['pins'])*25+25)
    doc('SYMBOL',sym)
    emit('CANVAS',{'originX':0,'originY':0},'CANVAS')
    emit('PART',{'BBOX':[-20,15,245,-height],'title':''},part)
    emit('META',{'title':m['name'],'description':'Finished module interface, procurement draft','tags':[],'docType':2,'source':''},'META')
    emit('RECT',dict(partId=part,groupId='',locked=False,zIndex=0,dotX1=0,dotY1=15,dotX2=245,dotY2=-height,radiusX=0,radiusY=0,rotation=0,strokeColor='#283B47',strokeStyle='SOLID',fillColor=None,strokeWidth=1,fillStyle=None),'body')
    for i,(number,name,net,direction) in enumerate(m['pins']):
        pid=f'pin{i}'
        y=-20-i*25
        emit('PIN',dict(partId=part,groupId='',locked=False,zIndex=2,display=True,x=-20,y=y,length=20,rotation=0,color=None,pinShape='NONE'),pid)
        attr(pid,'Pin Name',name,6,y,True,part)
        attr(pid,'Pin Number',number,-18,y+6,False,part)
        attr(pid,'Pin Type',direction,part=part)
        netlist.setdefault(net,[]).append({'module':m['ref'],'pin':number,'direction':direction})
    doc('DEVICE',dev)
    emit('META',{'title':m['name'],'tags':[],'source':'','images':[],
        'attributes':{'Symbol':sym,'Footprint':'','Designator':m['ref'],'Description':'Module-level interface only; no bare MCU circuit'}},'META')

doc('BOARD','inspection_board')
emit('META',{'title':'Module assembly','zIndex':1},'META')
doc('SCH','inspection_sch')
emit('META',{'title':'Active inspection module schematic','board':'inspection_board','source':'','zIndex':1},'META')
doc('SCH_PAGE','inspection_page')
emit('CANVAS',{'originX':0,'originY':0},'CANVAS')
emit('META',{'title':'01 Control and low-voltage power','schematic':'inspection_sch','source':'','zIndex':1},'META')
text('ACTIVE INSPECTION / MODULE INTERCONNECT / PROCUREMENT DRAFT',40,-35,17)
text('Do not wire until exact board revision and physical connector orientation are verified.',40,-65,11)
text('Preassembled modules only. Camera connects through manufacturer CSI FFC; it is not a GPIO cable.',40,-85,10)
text('USB connectors shown as power interfaces. Servo current bypasses MCU and breadboard rails.',40,-105,10)
for m in modules:
    x,y=m['x'],m['y']; ref=m['ref']
    emit('COMPONENT',dict(locked=False,zIndex=2,partId='part_'+ref,groupId='',x=x,y=y,rotation=0,isMirror=False,attrs={}),ref)
    attr(ref,'Device','dev_'+ref)
    attr(ref,'Symbol','sym_'+ref)
    attr(ref,'Designator',ref,x,y+38,True)
    attr(ref,'Name',m['name'],x,y+25,True)
    for i,(_,_,net,_) in enumerate(m['pins']):
        yy=y-20-i*25; wid=f'w_{ref}_{i}'
        emit('WIRE',{'groupId':'','locked':False,'zIndex':4},wid)
        emit('LINE',dict(lineGroup=wid,startX=x-80,startY=yy,endX=x-20,endY=yy,strokeColor='#0F766E',strokeStyle='SOLID',fillColor=None,strokeWidth=1,fillStyle=None),'line_'+wid)
        attr(wid,'NET',net,x-80,yy+8,True)
text('GND is shared. NUCLEO_5V, P4_5V and SERVO_5V are independent positive rails; never parallel them.',40,-815,10)
text('NUCLEO USB charger: JP1 ON, JP5 U5V, whole-board current <=100mA; verify before standalone use.',40,-840,10)
text('Header pin numbers: official schematics only; inspect the delivered board before wiring.',40,-862,10)
text('v0.3 | source generated from official V3 format and example | not hardware tested',40,-884,9)
doc('CONFIG','CONFIG')
emit('UNIVERSAL',{'allowLibRename':True,'defaultNetName':True,'wireMultipleNet':False,'netLabelCrossPageConnection':True},'UNIVERSAL')
emit('META',{'defaultSheet':''},'META')
# Map document identities and every corresponding reference together. Primitive
# IDs and V3 component attributes retain their official-example representation.
document_ids = {name:doc_uuid(name) for _,name in docs}
def remap_document_ids(value):
    if isinstance(value, dict): return {k:remap_document_ids(v) for k,v in value.items()}
    if isinstance(value, list): return [remap_document_ids(v) for v in value]
    return document_ids.get(value,value) if isinstance(value,str) else value
normalized=[]
for record in lines:
    head, body = record[:-1].split('||',1)
    normalized.append(head+'||'+json.dumps(remap_document_ids(json.loads(body)),ensure_ascii=False,separators=(',',':'))+'|')
source='\n'.join(normalized)+'\n'
(OUT/'active-inspection.epru').write_text(source,encoding='utf-8',newline='\n')
(OUT/'document-id-map.json').write_text(json.dumps(document_ids,indent=2),encoding='utf-8')
with zipfile.ZipFile(OUT/'active-inspection.epro2','w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('project2.json',json.dumps({'title':'Active Inspection Modules v0.3','cbb_project':False,'editorVersion':'3.2.77','introduction':'Procurement draft, module interfaces only.','description':'Physical board identity remains unverified.','tags':'[]'}))
    z.writestr('active-inspection.epru',source)
(OUT/'expected-netlist.json').write_text(json.dumps(netlist,ensure_ascii=False,indent=2),encoding='utf-8')

# 同一份接口数据输出独立可阅读图；它不是 EDA 导入/ERC 的替代证据。
colors={'GND':'#475569','NUCLEO_5V':'#b45309','P4_5V':'#b45309','SERVO_5V':'#be123c',
        'UART_F4_TX':'#0369a1','UART_F4_RX':'#0369a1','PAN_PWM':'#047857','TILT_PWM':'#047857'}
svg=['<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1220" viewBox="0 0 1440 1220">',
     '<rect width="1440" height="1220" fill="#f8fafc"/>',
     '<style>text{font-family:Microsoft YaHei,Arial,sans-serif;fill:#172b36} .small{font-size:15px} .pin{font-size:14px}</style>']
def st(value,x,y,size=18,color=None,weight=None):
    extra=(f' fill="{color}"' if color else '')+(f' font-weight="{weight}"' if weight else '')
    svg.append(f'<text x="{x}" y="{y}" font-size="{size}"{extra}>{html.escape(value)}</text>')
st('巡点 · 模块接口连接图',48,53,30,weight='700')
st('采购前参考图 | 电源/针号依据官方资料 | 尚未到货验证',48,85,17)
st('相同网络名称表示电气相连；彩色线为信号或电源接口，USB 电源使用完整成品线。',48,115,17)
for i,m in enumerate(modules):
    power=i>=4
    bx=(65+(i-4)*460) if power else (65+(i%2)*700)
    by=730 if power else 160+(i//2)*285
    width=430 if power else 620
    svg.append(f'<rect x="{bx}" y="{by}" width="{width}" height="260" rx="10" fill="white" stroke="#cbd5e1"/>')
    st(m['ref']+'  '+m['name'],bx+20,by+30,17,weight='700')
    for j,(pin,label,net,direction) in enumerate(m['pins']):
        yy=by+64+j*31
        st(pin,bx+20,yy,14)
        st(label,bx+125,yy,13)
        port=285 if power else 432
        svg.append(f'<line x1="{bx+port}" y1="{yy-5}" x2="{bx+port+25}" y2="{yy-5}" stroke="{colors[net]}" stroke-width="2"/>')
        svg.append(f'<circle cx="{bx+port}" cy="{yy-5}" r="3" fill="white" stroke="{colors[net]}"/>')
        st(net,bx+port+31,yy,14,colors[net])
st('装配约束',48,1048,22,weight='700')
notes=[
    '1. 舵机正极只接 SERVO_5V，不能接 NUCLEO/P4 的 3.3V 或 5V 引脚；大电流不经过面包板。',
    '2. 三路成品电源正极各自独立，严禁并联；GND 共地。断电接线，额定值与实际电流仍需验证。',
    '3. NUCLEO 充电器供电：JP1 ON、JP5 U5V；该路径整板不超过 100mA，详见供电文档。',
    '4. OV5647 用原厂 CSI 排线接 P4；排针方向、FFC 接触面和运动余量在到货后核对。',
    '5. 本图由接口清单生成；嘉立创原生工程导入、ERC 和实物连线验收仍分别记录。']
for i,n in enumerate(notes): st(n,48,1080+i*27,16)
svg.append('</svg>')
(OUT/'module-interconnect.svg').write_text('\n'.join(svg),encoding='utf-8')
assert set(netlist)=={'UART_F4_TX','UART_F4_RX','PAN_PWM','TILT_PWM','GND','NUCLEO_5V','P4_5V','SERVO_5V'}
assert all(len(v)>=2 for v in netlist.values())
assert not any(p['module'].startswith('U') for p in netlist['SERVO_5V'])
print(json.dumps({'archive':str(OUT/'active-inspection.epro2'),'documents':len(docs),'records':len(lines),'nets':len(netlist),'sha256':hashlib.sha256((OUT/'active-inspection.epro2').read_bytes()).hexdigest(),'checks':'local source/net constraints only; EDA import and ERC pending'}))
