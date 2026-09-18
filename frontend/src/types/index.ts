export interface ModbusRegister {
  address: number
  name: string
  type: 'coil' | 'discrete' | 'holding' | 'input'
  value: number | boolean
  unit: string
  updatedAt: number
  // 越限阈值（可选）：超过 highLimit/低于 lowLimit 为 warning，
  // 超过 criticalHigh/criticalLow 为 critical
  lowLimit?: number
  highLimit?: number
  criticalLow?: number
  criticalHigh?: number
  // 模拟参数
  base?: number        // 均值回归基准
  step?: number        // 每轮随机波动幅度
  decimals?: number    // 数值精度（小数位）
  monotonic?: boolean  // 累计量：只增不减
}

export interface Device {
  id: string
  name: string
  ip: string
  port: number
  slaveId: number
  online: boolean
  registers: ModbusRegister[]
}

export interface Alarm {
  id: string
  deviceId: string
  deviceName: string
  register: string
  address: number
  message: string
  level: 'info' | 'warning' | 'critical'
  timestamp: number        // 首次越限时间
  lastTriggered: number    // 最近一次持续越限时间
  lastValue: number        // 最近一次越限读数
  triggerCount: number     // 连续越限轮数
  acknowledged: boolean
  acknowledgedAt?: number
  recovered: boolean       // 读数是否已回到正常范围
  recoveredAt?: number
}
