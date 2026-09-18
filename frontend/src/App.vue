<template>
  <div class="flex h-screen">
    <!-- Sidebar -->
    <div class="w-64 bg-gray-900 p-4 flex flex-col gap-3 border-r border-gray-800 overflow-y-auto">
      <h1 class="text-lg font-bold text-orange-400">Modbus 工业监控</h1>
      <div class="flex gap-2">
        <button @click="startPoll" :disabled="store.isPolling" class="flex-1 bg-green-700 py-1.5 rounded text-xs hover:bg-green-600 disabled:opacity-50">
          {{ store.isPolling ? '采集中...' : '开始采集' }}
        </button>
        <button @click="stopPoll" :disabled="!store.isPolling" class="flex-1 bg-red-700 py-1.5 rounded text-xs hover:bg-red-600 disabled:opacity-50">
          停止
        </button>
      </div>
      <div>
        <label class="text-gray-400 text-xs">轮询间隔: {{ store.pollInterval }}ms</label>
        <input type="range" :value="store.pollInterval" @input="onIntervalChange" min="200" max="5000" step="100" class="w-full" />
      </div>

      <h3 class="text-gray-400 text-xs mt-2">设备列表</h3>
      <div v-for="d in store.devices" :key="d.id"
        class="bg-gray-800 rounded p-2 text-sm"
        :class="store.selectedDevice?.id === d.id ? 'ring-1 ring-orange-500' : ''">
        <div class="flex justify-between cursor-pointer" @click="store.selectDevice(d.id)">
          <span>{{ d.name }}</span>
          <span class="w-2 h-2 rounded-full mt-1.5" :class="d.online ? 'bg-green-500' : 'bg-red-500'"></span>
        </div>
        <div class="flex justify-between items-center mt-1">
          <span class="text-xs text-gray-500">{{ d.ip }}:{{ d.port }} [{{ d.slaveId }}]</span>
          <button @click.stop="store.toggleDevice(d.id)"
            class="text-[10px] px-1.5 py-0.5 rounded"
            :class="d.online ? 'bg-red-900/60 text-red-300 hover:bg-red-800' : 'bg-green-900/60 text-green-300 hover:bg-green-800'">
            {{ d.online ? '停用' : '启用' }}
          </button>
        </div>
      </div>

      <div v-if="store.criticalAlarms.length" class="bg-red-900/50 rounded p-2 mt-2">
        <h4 class="text-red-400 text-xs font-bold">⚠ 严重告警（活动未确认） {{ store.criticalAlarms.length }}</h4>
        <div v-for="a in store.criticalAlarms.slice(0, 3)" :key="a.id" class="text-xs text-red-300 mt-1 truncate">
          {{ a.message }}
        </div>
      </div>

      <div class="text-xs text-gray-600 mt-auto">
        在线: {{ store.onlineDevices.length }}/{{ store.devices.length }}
      </div>
    </div>

    <!-- Main Dashboard -->
    <div class="flex-1 flex flex-col gap-3 p-4 overflow-y-auto">
      <!-- Register Gauges -->
      <div class="grid grid-cols-4 gap-3">
        <div v-for="item in gauges" :key="`${item.device.id}_${item.register.address}`"
          class="bg-gray-900 rounded-xl p-3">
          <div class="text-xs text-gray-400">{{ item.device.name }}</div>
          <div class="text-2xl font-bold" :class="item.device.online ? 'text-orange-400' : 'text-gray-600'">
            {{ formatValue(item.register) }}
          </div>
          <div class="text-xs text-gray-500">{{ item.register.name }} {{ item.register.unit }}</div>
        </div>
      </div>

      <!-- Chart -->
      <div class="bg-gray-900 rounded-xl p-3 flex-1">
        <h3 class="text-sm text-gray-400 mb-2">
          实时趋势 — {{ store.selectedDevice?.name || '选择设备' }}
        </h3>
        <TrendChart />
      </div>

      <!-- Alarm List -->
      <div class="bg-gray-900 rounded-xl p-3 max-h-64 flex flex-col">
        <div class="flex justify-between items-center mb-2">
          <h3 class="text-sm text-gray-400">
            告警记录
            <span class="text-xs text-gray-500">（待处理 {{ pendingAlarms.length }} 条）</span>
          </h3>
          <div class="flex items-center gap-3 text-xs">
            <label class="flex items-center gap-1 text-gray-400 cursor-pointer">
              <input type="checkbox" v-model="showHandled" />
              显示已处理
            </label>
            <button @click="store.clearHandledAlarms()"
              class="text-gray-400 hover:text-gray-200 disabled:opacity-40"
              :disabled="!hasHandled">
              清除已处理
            </button>
          </div>
        </div>

        <div v-if="store.prunedCount > 0" class="text-[11px] text-yellow-500/90 bg-yellow-900/20 rounded px-2 py-1 mb-1">
          记录已达上限（{{ maxAlarms }} 条），已有 {{ store.prunedCount }} 条较早的已处理记录被自动清理；活动告警与未确认的严重告警不会被删除。
        </div>

        <div class="overflow-y-auto flex-1">
          <div v-if="!visibleAlarms.length" class="text-xs text-gray-600 py-3 text-center">暂无告警记录</div>
          <div v-for="a in visibleAlarms" :key="a.id"
            class="flex justify-between items-center text-xs bg-gray-800 rounded p-2 mb-1"
            :class="{
              'border-l-4 border-red-500': a.level === 'critical' && !a.recovered,
              'border-l-4 border-yellow-500': a.level === 'warning' && !a.recovered,
              'border-l-4 border-gray-600 opacity-60': a.recovered,
            }">
            <div class="min-w-0">
              <div class="truncate">
                <span class="text-gray-500">[{{ a.id }}]</span>
                {{ a.message }}
                <span v-if="a.triggerCount > 1" class="text-gray-500">（连续 {{ a.triggerCount }} 轮）</span>
              </div>
              <div class="text-[10px] mt-0.5">
                <span v-if="!a.recovered" :class="a.acknowledged ? 'text-blue-400' : 'text-orange-400'">
                  {{ a.acknowledged ? '已确认 · 仍持续越限' : '持续中' }}
                </span>
                <span v-else :class="a.acknowledged ? 'text-green-400' : 'text-gray-400'">
                  {{ a.acknowledged ? '已处理' : '已恢复 · 待确认' }}
                </span>
                <span class="text-gray-500">
                  · 首次 {{ formatTime(a.timestamp) }} · 最近 {{ formatTime(a.lastTriggered) }}
                </span>
              </div>
            </div>
            <div class="flex gap-2 shrink-0 ml-2">
              <button v-if="!a.acknowledged" @click="store.acknowledgeAlarm(a.id)"
                class="text-blue-400 hover:underline">确认</button>
              <span v-else class="text-gray-500">{{ formatTime(a.acknowledgedAt) }} 已确认</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useModbusStore } from './store/modbus'
import TrendChart from './components/TrendChart.vue'
import type { Device, ModbusRegister } from './types'

const store = useModbusStore()
const showHandled = ref(false)
const maxAlarms = 50
let timer: number | null = null

const gauges = computed<{ device: Device; register: ModbusRegister }[]>(() =>
  store.devices.flatMap(d => d.registers.map(r => ({ device: d, register: r })))
)

// 待处理：未确认（含已恢复待确认）；已处理：已确认且已恢复
const pendingAlarms = computed(() => store.alarms.filter(a => !a.acknowledged))
const hasHandled = computed(() => store.alarms.some(a => a.acknowledged && a.recovered))
const visibleAlarms = computed(() =>
  showHandled.value ? store.alarms : store.alarms.filter(a => !(a.acknowledged && a.recovered))
)

function formatValue(r: ModbusRegister) {
  if (typeof r.value === 'boolean') return r.value ? 'ON' : 'OFF'
  const decimals = r.decimals ?? (r.value > 100 ? 0 : 1)
  return r.value.toFixed(decimals)
}

function formatTime(t?: number) {
  return t ? new Date(t).toLocaleTimeString() : '--:--:--'
}

function ensureTimer() {
  if (timer) { clearInterval(timer); timer = null }
  if (store.isPolling) {
    timer = window.setInterval(() => store.simulatePoll(), store.pollInterval)
  }
}

function startPoll() {
  store.isPolling = true
  ensureTimer()
}

function stopPoll() {
  store.isPolling = false
  if (timer) { clearInterval(timer); timer = null }
  store.persist()
}

function onIntervalChange(e: Event) {
  store.setPollInterval(Number((e.target as HTMLInputElement).value))
  ensureTimer() // 采集中调整间隔后，按新间隔重建定时器
}

onMounted(() => {
  store.restore()
  // 刷新前若处于采集状态，自动恢复采集
  ensureTimer()
})
onUnmounted(() => stopPoll())
</script>
