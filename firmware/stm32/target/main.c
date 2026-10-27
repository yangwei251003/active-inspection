/* NUCLEO-F401RE 采购前离线参考，未验证用户实际板卡。
   默认 INS_ENABLE_SERVO_OUTPUT=0；只有到货校验、空载校准及明确授权后才可另建启用版本。
   角度为 commanded，不含位置传感器，不能当作机械反馈。 */
#include "stm32f4xx_hal.h"
#include "inspection.h"
#ifndef INS_ENABLE_SERVO_OUTPUT
#define INS_ENABLE_SERVO_OUTPUT 0
#endif
static UART_HandleTypeDef uart;
static TIM_HandleTypeDef pwm;
static IWDG_HandleTypeDef watchdog;
static uint8_t rx_byte;
static volatile uint8_t rx_ring[256];
static volatile uint16_t rx_head,rx_tail;
static volatile bool rx_overflow,uart_error;
static ins_controller control;
static ins_parser parser;
static bool pwm_running;

/* 官方 startup 调用 newlib 的 __libc_init_array；本 C 工程不需额外运行时初始化。 */
void _init(void){}

static void panic(void){__disable_irq();for(;;){/* 已启动看门狗时由它复位；否则停机，不输出新运动。 */}}
static void check(HAL_StatusTypeDef result){if(result!=HAL_OK)panic();}
void SysTick_Handler(void){HAL_IncTick();}
void USART1_IRQHandler(void){HAL_UART_IRQHandler(&uart);}
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *h){
    if(h->Instance!=USART1)return;
    uint16_t next=(uint16_t)((rx_head+1U)&255U);
    if(next==rx_tail)rx_overflow=true;else{rx_ring[rx_head]=rx_byte;rx_head=next;}
    if(HAL_UART_Receive_IT(&uart,&rx_byte,1)!=HAL_OK)uart_error=true;
}
void HAL_UART_ErrorCallback(UART_HandleTypeDef *h){if(h->Instance==USART1)uart_error=true;}
static void clock_init(void){
    __HAL_RCC_PWR_CLK_ENABLE();__HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE2);
    RCC_OscInitTypeDef osc={0};osc.OscillatorType=RCC_OSCILLATORTYPE_HSI;osc.HSIState=RCC_HSI_ON;
    osc.HSICalibrationValue=RCC_HSICALIBRATION_DEFAULT;osc.PLL.PLLState=RCC_PLL_ON;
    osc.PLL.PLLSource=RCC_PLLSOURCE_HSI;osc.PLL.PLLM=16;osc.PLL.PLLN=336;osc.PLL.PLLP=RCC_PLLP_DIV4;osc.PLL.PLLQ=7;
    check(HAL_RCC_OscConfig(&osc));RCC_ClkInitTypeDef clk={0};
    clk.ClockType=RCC_CLOCKTYPE_SYSCLK|RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
    clk.SYSCLKSource=RCC_SYSCLKSOURCE_PLLCLK;clk.AHBCLKDivider=RCC_SYSCLK_DIV1;
    clk.APB1CLKDivider=RCC_HCLK_DIV2;clk.APB2CLKDivider=RCC_HCLK_DIV1;
    check(HAL_RCC_ClockConfig(&clk,FLASH_LATENCY_2));
}
static void uart_init(void){
    __HAL_RCC_GPIOA_CLK_ENABLE();__HAL_RCC_USART1_CLK_ENABLE();
    GPIO_InitTypeDef pin={0};pin.Pin=GPIO_PIN_9|GPIO_PIN_10;pin.Mode=GPIO_MODE_AF_PP;
    pin.Pull=GPIO_PULLUP;pin.Speed=GPIO_SPEED_FREQ_VERY_HIGH;pin.Alternate=GPIO_AF7_USART1;HAL_GPIO_Init(GPIOA,&pin);
    uart.Instance=USART1;uart.Init.BaudRate=115200;uart.Init.WordLength=UART_WORDLENGTH_8B;
    uart.Init.StopBits=UART_STOPBITS_1;uart.Init.Parity=UART_PARITY_NONE;uart.Init.Mode=UART_MODE_TX_RX;
    uart.Init.HwFlowCtl=UART_HWCONTROL_NONE;uart.Init.OverSampling=UART_OVERSAMPLING_16;
    check(HAL_UART_Init(&uart));HAL_NVIC_SetPriority(USART1_IRQn,5,0);HAL_NVIC_EnableIRQ(USART1_IRQn);
    check(HAL_UART_Receive_IT(&uart,&rx_byte,1));
}
static void pwm_init(void){
    /* 默认条件编译不会调用这里，也不会把 PA6/PA7 配为输出。 */
    __HAL_RCC_TIM3_CLK_ENABLE();__HAL_RCC_GPIOA_CLK_ENABLE();
    GPIO_InitTypeDef pin={0};pin.Pin=GPIO_PIN_6|GPIO_PIN_7;pin.Mode=GPIO_MODE_AF_PP;
    pin.Pull=GPIO_NOPULL;pin.Speed=GPIO_SPEED_FREQ_LOW;pin.Alternate=GPIO_AF2_TIM3;HAL_GPIO_Init(GPIOA,&pin);
    pwm.Instance=TIM3;pwm.Init.Prescaler=83;pwm.Init.CounterMode=TIM_COUNTERMODE_UP;
    pwm.Init.Period=19999;pwm.Init.ClockDivision=TIM_CLOCKDIVISION_DIV1;pwm.Init.AutoReloadPreload=TIM_AUTORELOAD_PRELOAD_ENABLE;
    check(HAL_TIM_PWM_Init(&pwm));TIM_OC_InitTypeDef oc={0};oc.OCMode=TIM_OCMODE_PWM1;
    oc.Pulse=1500;oc.OCPolarity=TIM_OCPOLARITY_HIGH;oc.OCFastMode=TIM_OCFAST_DISABLE;
    check(HAL_TIM_PWM_ConfigChannel(&pwm,&oc,TIM_CHANNEL_1));check(HAL_TIM_PWM_ConfigChannel(&pwm,&oc,TIM_CHANNEL_2));
}
static uint32_t pulse_us(int16_t angle){
    /* 仅参考映射：0..180°=>1000..2000us；实际舵机端点/安装方向必须校准。 */
    return 1000U+(uint32_t)angle*1000U/1800U;
}
static void pwm_update(uint32_t now){
    bool allowed=ins_output_permitted(&control,now);
    if(!allowed&&pwm_running){HAL_TIM_PWM_Stop(&pwm,TIM_CHANNEL_1);HAL_TIM_PWM_Stop(&pwm,TIM_CHANNEL_2);pwm_running=false;}
    if(!allowed)return;
    __HAL_TIM_SET_COMPARE(&pwm,TIM_CHANNEL_1,pulse_us(control.commanded.pan));
    __HAL_TIM_SET_COMPARE(&pwm,TIM_CHANNEL_2,pulse_us(control.commanded.tilt));
    if(!pwm_running){check(HAL_TIM_PWM_Start(&pwm,TIM_CHANNEL_1));check(HAL_TIM_PWM_Start(&pwm,TIM_CHANNEL_2));pwm_running=true;}
}
static void transmit(uint16_t seq,uint16_t type,int32_t a,int32_t b){
    char buffer[80];ins_frame f={seq,type,a,b};size_t n=ins_encode(&f,buffer,sizeof(buffer));
    if(n&&HAL_UART_Transmit(&uart,(uint8_t*)buffer,(uint16_t)n,20)!=HAL_OK)uart_error=true;
}
int main(void){
    HAL_Init();clock_init();ins_init(&control,HAL_GetTick());ins_parser_init(&parser);
    if(INS_ENABLE_SERVO_OUTPUT){pwm_init();ins_set_output_enabled(&control,true,HAL_GetTick());}
    uart_init();watchdog.Instance=IWDG;watchdog.Init.Prescaler=IWDG_PRESCALER_64;watchdog.Init.Reload=2000;
    check(HAL_IWDG_Init(&watchdog));uint32_t sent_at=HAL_GetTick();
    for(;;){
        if(uart_error||rx_overflow){
            /* 传输异常后停止运动并丢弃不完整帧，避免拼接损坏命令。 */
            __disable_irq();rx_tail=rx_head;uart_error=false;rx_overflow=false;__enable_irq();
            ins_parser_init(&parser);ins_pause(&control);
            HAL_UART_AbortReceive(&uart);check(HAL_UART_Receive_IT(&uart,&rx_byte,1));
        }
        /* 每轮最多消费64字节，使持续串口输入也不能饿死心跳检查/看门狗。 */
        for(unsigned count=0;count<64&&rx_tail!=rx_head;count++){
            char ch=(char)rx_ring[rx_tail];rx_tail=(uint16_t)((rx_tail+1U)&255U);ins_frame f;
            if(ins_parser_feed(&parser,ch,&f)){
                ins_result result=ins_command(&control,&f,HAL_GetTick());transmit(f.seq,101,f.type,result);
            }
        }
        uint32_t now=HAL_GetTick();ins_tick(&control,now);pwm_update(now);
        if((uint32_t)(now-sent_at)>=200U){
            /* 遥测报告最后消费的seq，协处理器单独重启时先读取，再从seq+1发送。 */
            transmit(control.last_seq,102,control.commanded.pan,control.commanded.tilt);
            transmit(control.last_seq,103,control.phase,control.active_preset);sent_at=now;
        }
        check(HAL_IWDG_Refresh(&watchdog));
    }
}
