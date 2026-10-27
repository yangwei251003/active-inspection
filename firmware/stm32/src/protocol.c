#include "inspection.h"
#include <stdio.h>
#include <string.h>

uint16_t ins_crc16(const char *data, size_t length) {
    uint16_t crc=0xffffU;
    for (size_t i=0;i<length;i++) {
        crc ^= (uint16_t)(uint8_t)data[i] << 8;
        for (unsigned j=0;j<8;j++) crc=(crc&0x8000U)?(uint16_t)((crc<<1)^0x1021U):(uint16_t)(crc<<1);
    }
    return crc;
}
void ins_parser_init(ins_parser *p) { memset(p,0,sizeof(*p)); }
static int hexval(char ch) {
    if (ch>='0'&&ch<='9') return ch-'0';
    if (ch>='A'&&ch<='F') return ch-'A'+10;
    if (ch>='a'&&ch<='f') return ch-'a'+10;
    return -1;
}
/* 不使用 atoi/宽松 scanf：拒绝空白、加号、整数溢出、缺字段、尾随字符。 */
static bool number(const char **pos, const char *end, int32_t *value) {
    const char *p=*pos; bool negative=false; uint32_t n=0;
    if (p<end&&*p=='-') {negative=true;p++;}
    if (p==end||*p<'0'||*p>'9') return false;
    while(p<end&&*p>='0'&&*p<='9') {
        uint32_t d=(uint32_t)(*p-'0');
        if(n>(2147483647U-d)/10U) return false;
        n=n*10U+d;p++;
    }
    *value=negative?-(int32_t)n:(int32_t)n;*pos=p;return true;
}
static bool decode(ins_parser *p,ins_frame *f) {
    if(p->length<12) {p->bad_format++;return false;}
    size_t star=p->length-5;
    if(p->body[star]!='*') {p->bad_format++;return false;}
    uint16_t expected=0;
    for(size_t i=star+1;i<p->length;i++) {
        int v=hexval(p->body[i]);if(v<0){p->bad_format++;return false;}
        expected=(uint16_t)((expected<<4)|(unsigned)v);
    }
    if(ins_crc16(p->body,star)!=expected){p->bad_crc++;return false;}
    const char *cursor=p->body,*end=p->body+star; int32_t v[4];
    for(unsigned i=0;i<4;i++) {
        if(!number(&cursor,end,&v[i])){p->bad_format++;return false;}
        if(i<3) {if(cursor==end||*cursor++!=','){p->bad_format++;return false;}}
    }
    if(cursor!=end||v[0]<0||v[0]>65535||v[1]<0||v[1]>65535){p->bad_format++;return false;}
    f->seq=(uint16_t)v[0];f->type=(uint16_t)v[1];f->a=v[2];f->b=v[3];return true;
}
bool ins_parser_feed(ins_parser *p,char byte,ins_frame *frame) {
    if(byte=='@'){p->length=0;p->receiving=true;p->overflow=false;return false;}
    if(!p->receiving)return false;
    if(byte=='\n') {
        p->receiving=false;
        if(p->overflow)return false;
        return decode(p,frame);
    }
    if(p->overflow)return false;
    if(p->length==sizeof(p->body)-1) {p->overflow=true;p->too_long++;return false;}
    p->body[p->length++]=byte;return false;
}
size_t ins_encode(const ins_frame *f,char *out,size_t capacity) {
    char body[INS_FRAME_MAX];
    int n=snprintf(body,sizeof(body),"%u,%u,%ld,%ld",(unsigned)f->seq,(unsigned)f->type,(long)f->a,(long)f->b);
    if(n<0||(size_t)n>=sizeof(body)||capacity<(size_t)n+8U)return 0;
    int written=snprintf(out,capacity,"@%s*%04X\n",body,(unsigned)ins_crc16(body,(size_t)n));
    return written>0&&(size_t)written<capacity?(size_t)written:0;
}
