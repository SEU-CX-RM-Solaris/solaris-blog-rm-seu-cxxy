---
category: "STM32 电控入门"
title: "STM32 电控入门 08 · HAL 函数速查手册"
publishDate: "2026-11-08"
description: "HAL 库常用函数一表速查：系统与延时、GPIO、UART、TIM、ADC、I2C，以及 DMA / RTC / DWT / RTOS。"
tags: ["STM32", "HAL", "速查"]
---
## 系统与延时
`HAL_Init()` ｜ `SystemClock_Config()`(用户) ｜ `HAL_RCC_OscConfig(&osc)` ｜ `HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_2)` ｜ `HAL_RCC_GetHCLKFreq()` ｜ `HAL_Delay(ms)` ｜ `HAL_GetTick()` ｜ `HAL_IncTick()` ｜ `Error_Handler()` ｜ `__disable_irq()`(CMSIS)

## GPIO
`__HAL_RCC_GPIOx_CLK_ENABLE()` ｜ `HAL_GPIO_Init` ｜ `HAL_GPIO_WritePin` ｜ `HAL_GPIO_ReadPin` ｜ `HAL_GPIO_TogglePin` ｜ `HAL_GPIO_DeInit` ｜ `HAL_GPIO_EXTI_IRQHandler(pin)` ｜ `HAL_GPIO_EXTI_Callback(pin)` ｜ `HAL_NVIC_SetPriority` ｜ `HAL_NVIC_EnableIRQ` ｜ `__HAL_AFIO_REMAP_SWJ_NOJTAG()`(释放 PB3/PB4/PA15) ｜ `__HAL_AFIO_REMAP_TIM3_PARTIAL()`

## UART
`HAL_UART_Init` ｜ `HAL_UART_Transmit(h,p,n,timeout)` ｜ `HAL_UART_Receive(h,p,n,timeout)` ｜ `HAL_UART_Transmit_IT(h,p,n)` ｜ `HAL_UART_Receive_IT(h,p,n)` ★回调里重注册 ｜ `HAL_UART_Transmit_DMA` ｜ `HAL_UARTEx_ReceiveToIdle_DMA(h,p,n)` ｜ `HAL_UARTEx_RxEventCallback(h,size)` ｜ `HAL_UART_RxCpltCallback(h)` ｜ `HAL_UART_TxCpltCallback(h)` ｜ `HAL_UART_IRQHandler(h)` ｜ `__HAL_DMA_DISABLE_IT(h->hdmarx, DMA_IT_HT)` ｜ `__HAL_UART_ENABLE_IT`

## TIM
`HAL_TIM_Base_Init/Start/Stop` ｜ `HAL_TIM_Base_Start_IT/Stop_IT` ｜ `HAL_TIM_PWM_Init/ConfigChannel/Start/Stop/Start_DMA` ｜ `HAL_TIM_IC_Init/ConfigChannel/Start_IT/Stop_IT` ｜ `HAL_TIM_Encoder_Init/Encoder_Start` ｜ `HAL_TIM_IRQHandler` ｜ `HAL_TIM_PeriodElapsedCallback` ｜ `HAL_TIM_IC_CaptureCallback` ｜ `HAL_TIM_ReadCapturedValue(htim,ch)` ｜ `__HAL_TIM_SET_COMPARE / __HAL_TIM_GET_COMPARE` ｜ `__HAL_TIM_SET_COUNTER / __HAL_TIM_GET_COUNTER` ｜ `__HAL_TIM_SET_AUTORELOAD` ｜ `__HAL_TIM_SET_CAPTUREPOLARITY(htim,ch,RISING/FALLING)`

## ADC
`HAL_ADC_Init` ｜ `HAL_ADC_ConfigChannel` ｜ `HAL_ADC_Start` ｜ `HAL_ADC_PollForConversion(h,timeout)` ｜ `HAL_ADC_GetValue` ｜ `HAL_ADC_Start_DMA(h,buf,len)`

## I2C
`HAL_I2C_Init` ｜ `HAL_I2C_Master_Transmit/Receive(h,addr,p,n,timeout)` ｜ `HAL_I2C_Mem_Write/Read(h,addr,reg,regsize,p,n,timeout)` ｜ 地址=7位左移1位

## DMA / RTC / DWT / RTOS
`HAL_DMA_Init` ｜ `HAL_DMA_IRQHandler` ｜ `__HAL_LINKDMA(periph, hdma[x], hdmaX)` ｜
`HAL_RTC_Init/SetTime/GetTime/SetDate/GetDate`（Time 先于 Date）｜ `HAL_PWR_EnableBkUpAccess()` ｜
`DWT_Delay_Init()` ｜ `DWT_Delay_us(us)` ｜
`osKernelInitialize()` ｜ `osKernelStart()` ｜ `osThreadNew(fn,arg,attr)` ｜ `osDelay(ticks)`

---

> 本文基于「波特律动」STM32 学习套件 V3.2 的例程源码与官方图文教程整理：[docs.keysking.com](http://docs.keysking.com/docs/stm32/example/) ｜ B站视频（UID 6100925）。
