---
category: "STM32 电控入门"
title: "STM32 电控入门 06 · I2C 与 SPI：传感器总线"
publishDate: "2026-11-08"
description: "I2C 协议基础、硬件 I2C 读取温湿度传感器与 OLED 帧缓冲驱动、软件模拟 I2C/SPI 的适用场景与写法——一切传感器通信的模板。"
tags: ["STM32", "I2C", "SPI"]
---
## 6.1 协议基础

- 两线：SCL（时钟，主机产生）+ SDA（数据）。都是**开漏+上拉**，空闲为高。
- **起始**：SCL 高时 SDA 下跳；**停止**：SCL 高时 SDA 上跳；每 8 位后第 9 个时钟由接收方拉低 SDA 表示 **ACK**。
- **地址**：7 位地址左移 1 位成 8 位格式给 HAL（最低位是读写位，HAL 自动填）。**必记**：AHT20 `0x38→0x70`，OLED `0x3D→0x7A`，MPU6050 `0x68→0xD0`。
- 一条总线挂多个器件靠地址区分（OLED+AHT20+MPU6050 可共挂 PB6/PB7）。

## 6.2 必学函数

```c
// 主模式纯数据流（AHT20 这类命令型器件用）
HAL_StatusTypeDef HAL_I2C_Master_Transmit(I2C_HandleTypeDef *hi2c, uint16_t DevAddress,
                                          uint8_t *pData, uint16_t Size, uint32_t Timeout);
HAL_StatusTypeDef HAL_I2C_Master_Receive(同上 5 参数);

// 寄存器型器件用（自动在数据前插寄存器地址）—— MP6050/EEPROM 天天用
HAL_StatusTypeDef HAL_I2C_Mem_Write(I2C_HandleTypeDef *hi2c, uint16_t DevAddress,
                                    uint16_t MemAddress, uint16_t MemAddSize,
                                    uint8_t *pData, uint16_t Size, uint32_t Timeout);
HAL_StatusTypeDef HAL_I2C_Mem_Read(同上 7 参数);
// MemAddSize: I2C_MEMADD_SIZE_8BIT（多数传感器）/ I2C_MEMADD_SIZE_16BIT
// 检查返回值 != HAL_OK 做错误处理（例程为简洁没查）
```

## 6.3 AHT20 驱动流程（一切 I2C 传感器的模板）

```c
AHT20_Init():    HAL_Delay(40) 上电等待 → 读1字节状态 → bit3==0 则发 {0xBE,0x08,0x00} 校准命令
AHT20_Read():    发 {0xAC,0x33,0x00} 触发测量 → HAL_Delay(75) 等测量 → 读6字节
                 → 校验 bit7(busy)==0 → 位拼接：
                 湿度 = (buf[1]<<12 | buf[2]<<4 | buf[3]>>4) × 100.0 / 2^20
                 温度 = ((buf[3]&0x0F)<<16 | buf[4]<<8 | buf[5]) × 200.0 / 2^20 − 50
```
⚠️ 拼位段时 `(uint32_t)` 强转不能省（uint8_t 左移 12 位前必须提升，否则溢出）。

## 6.4 OLED 驱动架构（帧缓冲思想）

- 显存：`uint8_t OLED_GRAM[8][128]`（1KB，8 页×128 列，纵向取模，bit0 在上）。
- **使用三步曲**：`OLED_Init()` → 循环 { `OLED_NewFrame()`（清显存）→ 各种 Draw/Print 画进内存 → `OLED_ShowFrame()`（逐页 I2C 整发）}。先画后刷=双缓冲，防闪烁。
- API 清单：`OLED_PrintASCIIChar/String`（afont8x6~24x12 字库）、`OLED_PrintString`（中文 UTF-16x16 字库，取模工具 led.baud-dance.com）、`OLED_DrawLine`（Bresenham 算法）/`DrawRectangle(+Filled)`/`DrawCircle(+Filled)`/`DrawImage`、`OLED_SetColorMode`（正/反色）。
- 关键细节：每字节前有控制字节（0x00=命令 / 0x40=数据）；`const` 字模数组必须放 Flash（RAM 只有 20KB）；`static` 缓冲不占栈。

## 6.5 软件 I2C（I2C_Soft）—— 什么时候、怎么写

- **动机**：F1 硬件 I2C 有历史 bug（BUSY 卡死）+ 引脚不固定（硬件 I2C 只有固定几组）。
- **实现要点**：SCL 推挽输出，SDA 开漏+上拉（"线与"总线，写 1 即释放）；`SDA_IN()/SDA_OUT()` 运行时切换方向；每步电平翻转间插 `I2C_Delay()`（NOP 空转）；**`I2C_WaitAck()` 必须带超时**（轮询 250 次失败就 Stop 返回，防器件掉线死机）。
- 结构：`I2C_Start/Stop/SendByte/ReadByte/Ack/NAck/WaitAck` → 封装成 `I2C_WriteData(addr,data,len)` / `I2C_ReadDate(addr,data,len)`（最后字节回 NACK）。器件层（aht20.c）代码与硬件 I2C 版完全相同——**分层的好处：换总线层不动器件层**。

## 6.6 软件 SPI（softSPI）

- 四线：SCK/MOSI/MISO/CS（片选低有效）。**无地址无应答，全双工**——读也要写 dummy(0xFF)。
- **模式 = CPOL（空闲电平）× CPHA（采样沿）**：模式 0（CPOL=0,CPHA=0）最常用；主从必须一致。
- 移位收发一字节（模式0核心，背下来）：
```c
for (i = 0; i < 8; i++) {
    if (byte & 0x80) MOSI_Set; else MOSI_Clr;  // 先摆最高位（MSB first）
    byte <<= 1;
    SCLK_Set;  Delay;
    data <<= 1; if (MISO_Read) data |= 0x01;   // 时钟有效期间采样
    SCLK_Clr;  Delay;
}
// 使用：CS_Low → 收发N字节 → CS_High
```
- **结构体封装多实例**（教科书级 C 面向对象）：
```c
typedef struct {
  GPIO_TypeDef *SCLK_GPIO; uint32_t SCLK_Pin;   // ...四组引脚
  uint32_t Delay_Time;   // 半位延时→决定频率
  uint8_t CPOL, CPHA;
} SoftSPI_TypeDef;
SoftSPI_TypeDef SoftSPI1;    // 可定义 SoftSPI2、SoftSPI3...
```
- RM 关联：**ICM-20602/MPU6000 IMU 就是 SPI**（云台姿态数据源），W25Q64 Flash 掉电存 PID 参数/机械零点，NRF24L01 无线模块——全部套用"CS 拉低→发寄存器地址→连读→CS 拉高"模板。

---

> 本文基于「波特律动」STM32 学习套件 V3.2 的例程源码与官方图文教程整理：[docs.keysking.com](http://docs.keysking.com/docs/stm32/example/) ｜ B站视频（UID 6100925）。
