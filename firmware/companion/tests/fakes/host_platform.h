#pragma once
#include <assert.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
typedef int esp_err_t;
typedef struct host_queue {unsigned count,capacity;size_t item_size;unsigned char *bytes;} *QueueHandle_t;
typedef struct {int baud_rate,data_bits,parity,stop_bits,flow_ctrl,source_clk;} uart_config_t;
#define ESP_OK 0
#define ESP_ERROR_CHECK(expr) assert((expr)==0)
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define configASSERT assert
#define pdTRUE 1
#define portMAX_DELAY 0xffffffffu
#define pdMS_TO_TICKS(x) (x)
#define UART_NUM_1 1
#define UART_DATA_8_BITS 8
#define UART_PARITY_DISABLE 0
#define UART_STOP_BITS_1 1
#define UART_HW_FLOWCTRL_DISABLE 0
#define UART_SCLK_DEFAULT 0
#define UART_PIN_NO_CHANGE -1
#define CONFIG_AI_UART_ENABLE 1
#define CONFIG_AI_UART_TX 20
#define CONFIG_AI_UART_RX 21
extern int64_t host_mono_ms;
static inline int64_t esp_timer_get_time(void){return host_mono_ms*1000;}
static inline QueueHandle_t xQueueCreate(unsigned capacity,size_t size){QueueHandle_t q=calloc(1,sizeof(*q));assert(q);q->bytes=calloc(capacity,size);assert(q->bytes);q->item_size=size;q->capacity=capacity;return q;}
static inline int xQueueSend(QueueHandle_t q,const void *item,unsigned ticks){(void)ticks;if(q->count==q->capacity)return 0;memcpy(q->bytes+q->count++*q->item_size,item,q->item_size);return 1;}
static inline int xQueueReceive(QueueHandle_t q,void *item,unsigned ticks){(void)ticks;if(!q->count)return 0;memcpy(item,q->bytes,q->item_size);--q->count;memmove(q->bytes,q->bytes+q->item_size,q->count*q->item_size);return 1;}
static inline int xQueueReset(QueueHandle_t q){q->count=0;return 1;}
static inline int uart_write_bytes(int u,const void *b,size_t n){(void)u;(void)b;return (int)n;}
static inline int uart_read_bytes(int u,void *b,size_t n,int t){(void)u;(void)b;(void)n;(void)t;return 0;}
static inline int uart_driver_install(int u,int r,int t,int n,void *q,int flags){(void)u;(void)r;(void)t;(void)n;(void)q;(void)flags;return 0;}
static inline int uart_param_config(int u,const uart_config_t *c){(void)u;(void)c;return 0;}
static inline int uart_set_pin(int u,int tx,int rx,int rts,int cts){(void)u;(void)tx;(void)rx;(void)rts;(void)cts;return 0;}
static inline void xTaskCreate(void (*f)(void*),const char *n,int stack,void *a,int prio,void *out){(void)f;(void)n;(void)stack;(void)a;(void)prio;(void)out;}
static inline void vTaskDelay(int t){(void)t;}
