// ==================== 智能响应式网格交易系统 ====================
// 核心改进：
// 1. 动态价格跟踪 - 网格中心随当前价格移动
// 2. 响应式网格重置 - 价格超出阈值时自动调整
// 3. 利润率控制 - 通过固定买卖价差百分比
// 4. 完善资金管理 - FundManager追踪资金使用
// 5. 网格层级管理 - GridLevelManager管理每个网格状态
// 6. 保留原系统 - Cookie下单 + V5 API查询 + 双WebSocket监控

// ==================== Global Variables & Constants ====================
let orderResults = []; 
let messages = [];
let trackedOrders = new Map(); 
let gridOrders = new Map(); 
let activeBuyOrdersPerLevel = new Map(); 
let activeSellOrdersPerLevel = new Map(); 

let isPlacingOrder = false;
let isExecutingGridCheck = false; // 防止并发执行

// 响应式网格配置
let gridConfig = {
    symbol: 'NXPCUSDT',
    profitPercent: 2.5,            // 利润百分比 (买卖价差%)
    gridCount: 10,                 // 网格数量
    capitalPercent: 100,           // 资金使用百分比（默认100%）
    totalUsdt: 100,                // 实际投入USDT（根据capitalPercent动态计算）
    rebalanceThreshold: 15,        // 重置阈值百分比（价格偏离中心超过此值触发重置）

    // 🛡️ 止损配置
    gridStoplossEnabled: true,     // 启用每格止损
    gridStoplossPercent: 5,        // 每格止损百分比（默认5%）
    totalStoplossEnabled: true,    // 启用整体止损
    totalStoplossUsdt: 10,         // 整体止损金额（默认10 USDT）

    // 动态计算字段
    centerPrice: 0,                // 网格中心价格
    upperPrice: 0,                 // 当前上限
    lowerPrice: 0,                 // 当前下限
    usdtPerGrid: 0,
    interval: 0,
    levels: [],

    // 精度配置
    basePrecision: 5,
    quotePrecision: 5,
    qtyPrecision: 1,
};

let instrumentInfo = {}; 
let serverTimeOffset = 0;
let priceWsHeartbeatInterval = null;
let orderWsHeartbeatInterval = null;
let reconnectAttempts = 0; 
let isGridRunning = false;
let currentPrice = null;
let currentFeeRate = { takerFeeRate: '0.001', makerFeeRate: '0.001' }; 
const maxReconnectDelay = 30000; 

var API_KEY = ''; 
var API_SECRET = ''; 
const RECV_WINDOW = 20000; 
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; 

let priceWs = null;
let orderWs = null;
let gridCheckInterval = null;
let priceMonitorInterval = null; // 价格监控定时器
let orderPollingInterval = null; // 订单轮询定时器
let rebalanceCount = 0; // 重置计数器
let autoRebalanceEnabled = true; // 是否启用自动重置
let checkIntervalSeconds = 10; // 检查间隔

// 🛡️ 止损统计
let stoplossTriggerCount = 0; // 止损触发次数
let totalStoplossTriggered = false; // 整体止损是否已触发

// ==================== 速刷模式变量 ====================
let isBrushRunning = false;
let brushInterval = null;
let brushStats = {
    startTime: null,
    brushCount: 0,
    totalVolume: 0,
    totalFees: 0,
    netLoss: 0,
    consecutiveErrors: 0,
    runtimeUpdateInterval: null
};

let brushConfig = {
    symbol: 'NXPCUSDT',
    interval: 6,               // 刷单间隔（秒）- 加快速度
    capitalPercent: 100,       // 使用资金百分比
    priceOffset: 0.08,         // 价格偏移百分比（优化为0.08%）
    makerMode: true,           // 是否启用Maker模式（✅ 低买高卖+低手续费）
    orderTimeout: 45,          // 订单超时时间（秒）- 快速决策
    adaptiveMode: true,        // 自适应价格调整（超时后缩小偏移）
    maxLoss: 50,              // 最大亏损USDT
    maxVolume: 100000,        // 最大交易量
    stopOnError: true         // 出错是否停止
};

// ==================== DOM Elements ====================
let gridSymbolInput, profitPercentInput, gridCountInput, capitalPercentInput;
let rebalanceThresholdInput, checkIntervalInput, autoRebalanceCheckbox;
let usdtPerGridSpan, priceIntervalSpan, gridPreviewTableBody;
let currentUpperPriceSpan, currentLowerPriceSpan, gridCenterPriceSpan, rebalanceCountSpan;
let startGridBtn, stopGridBtn, calculateGridBtn, forceRebalanceBtn, gridStatusSpan;
let currentPriceSpan, lastUpdatedSpan, feeRateSpan, currentSymbolSpan;
let apiKeyInput, apiSecretInput, passwordInput;
let messageList;

// 统计显示元素
let runtimeSpan, totalVolumeSpan, buyVolumeSpan, sellVolumeSpan, feesCostSpan;
let buyCountSpan, sellCountSpan, netProfitSpan;

// 🛡️ 止损UI元素
let gridStoplossEnabledCheckbox, gridStoplossPercentInput;
let totalStoplossEnabledCheckbox, totalStoplossUsdtInput;
let stoplossTriggerCountSpan, totalStoplossStatusSpan;

// 🚀 速刷模式UI元素
let brushSymbolInput, brushIntervalInput, brushCapitalPercentInput, brushPriceOffsetInput;
let brushMakerModeCheckbox, brushOrderTimeoutInput, brushAdaptiveModeCheckbox;
let brushMaxLossInput, brushMaxVolumeInput, brushStopOnErrorCheckbox;
let brushRuntimeSpan, brushCountSpan, brushVolumeSpan, brushFeesSpan, brushLossSpan, brushStatusSpan;
let startBrushBtn, stopBrushBtn;

// ==================== 资金管理和网格层级系统 ====================

// 资金池管理器
class FundManager {
    constructor(totalUsdt) {
        this.initialTotal = totalUsdt;
        this.totalUsdt = totalUsdt;
        this.availableUsdt = totalUsdt;
        this.lockedInBuyOrders = 0;
        this.lockedInPositions = 0;
        this.reserveRatio = 0.05; // 保留5%作为缓冲
    }
    
    getAvailableForOrders() {
        const reserved = this.totalUsdt * this.reserveRatio;
        return Math.max(0, this.availableUsdt - reserved);
    }
    
    lockForBuy(amount) {
        const available = this.getAvailableForOrders();
        if (available >= amount) {
            this.lockedInBuyOrders += amount;
            this.updateAvailable();
            return true;
        }
        return false;
    }
    
    unlockFromBuy(amount) {
        this.lockedInBuyOrders = Math.max(0, this.lockedInBuyOrders - amount);
        this.updateAvailable();
    }
    
    buyOrderFilled(buyAmount) {
        this.lockedInBuyOrders = Math.max(0, this.lockedInBuyOrders - buyAmount);
        this.lockedInPositions += buyAmount;
        this.updateAvailable();
    }
    
    sellOrderFilled(costAmount, sellAmount) {
        this.lockedInPositions = Math.max(0, this.lockedInPositions - costAmount);
        const profit = sellAmount - costAmount;
        this.totalUsdt += profit;
        this.updateAvailable();
        return profit;
    }
    
    updateAvailable() {
        this.availableUsdt = this.totalUsdt - this.lockedInBuyOrders - this.lockedInPositions;
    }
    
    getStatus() {
        return {
            total: this.totalUsdt.toFixed(2),
            available: this.availableUsdt.toFixed(2),
            availableForOrders: this.getAvailableForOrders().toFixed(2),
            buyOrders: this.lockedInBuyOrders.toFixed(2),
            positions: this.lockedInPositions.toFixed(2),
            usagePercent: ((this.totalUsdt - this.availableUsdt) / this.totalUsdt * 100).toFixed(1),
            profit: (this.totalUsdt - this.initialTotal).toFixed(2)
        };
    }
    
    reset(newTotal) {
        this.initialTotal = newTotal;
        this.totalUsdt = newTotal;
        this.availableUsdt = newTotal;
        this.lockedInBuyOrders = 0;
        this.lockedInPositions = 0;
    }
}

// 网格层级管理器
class GridLevelManager {
    constructor(index, buyPrice, sellPrice, quantity, usdtAmount) {
        this.index = index;
        this.buyPrice = buyPrice;
        this.sellPrice = sellPrice;
        this.quantity = quantity;
        this.usdtAmount = usdtAmount;

        this.state = 'IDLE'; // IDLE, PLACING_BUY, BUY_ACTIVE, BOUGHT, PLACING_SELL, SELL_ACTIVE
        this.buyOrderId = null;
        this.sellOrderId = null;
        this.lockedAmount = 0;
        this.costBasis = 0;
        this.actualQuantity = 0;  // ✅ 实际成交数量
        this.sellRetryCount = 0;  // ✅ 卖单重试次数
        this.lastSellAttempt = 0; // ✅ 上次尝试下卖单的时间戳
        this.buyFilledTime = 0;   // ✅ 买单成交时间，用于计算币到账延迟
    }

    prepareForBuy() {
        if (this.state !== 'IDLE') return false;
        this.state = 'PLACING_BUY';
        return true;
    }

    buyOrderPlaced(orderId) {
        this.state = 'BUY_ACTIVE';
        this.buyOrderId = orderId;
    }

    buyOrderFailed() {
        this.state = 'IDLE';
        this.buyOrderId = null;
    }

    buyOrderFilled(actualQty = null) {
        this.state = 'BOUGHT';
        this.actualQuantity = actualQty || this.quantity;  // ✅ 保存实际成交数量
        this.costBasis = this.buyPrice * this.actualQuantity;
        this.buyFilledTime = Date.now();  // ✅ 记录买单成交时间
    }
    
    prepareForSell() {
        // ✅ BOUGHT和STUCK状态都可以尝试卖出
        if (this.state !== 'BOUGHT' && this.state !== 'STUCK') return false;

        const now = Date.now();

        // ✅ 第一次尝试卖出：必须距离买单成交至少15秒（增加等待时间）
        if (this.sellRetryCount === 0) {
            if (this.buyFilledTime > 0 && (now - this.buyFilledTime) < 15000) {
                // 买单成交不到15秒，不尝试下卖单
                return false;
            }
        }
        // ✅ 重试：距离上次尝试至少10秒（增加重试间隔）
        else {
            if (this.lastSellAttempt > 0 && (now - this.lastSellAttempt) < 10000) {
                return false;
            }
        }

        this.state = 'PLACING_SELL';
        this.lastSellAttempt = now;
        this.sellRetryCount++;
        return true;
    }
    
    sellOrderPlaced(orderId) {
        this.state = 'SELL_ACTIVE';
        this.sellOrderId = orderId;
        this.sellRetryCount = 0;  // ✅ 重置重试计数
    }

    sellOrderFailed() {
        // ✅ 如果重试次数超过上限，标记为"卡住"状态，不清空持仓信息
        if (this.sellRetryCount >= 20) {
            addMessage(`⚠️ L${this.index + 1} 卖单重试${this.sellRetryCount}次仍失败，标记为异常持仓`, 'error');
            this.state = 'STUCK';  // ✅ 新增STUCK状态，保留持仓数据
            // ❌ 不清空 actualQuantity 和 costBasis，保留持仓信息！
        } else {
            this.state = 'BOUGHT';
        }
        this.sellOrderId = null;
    }
    
    sellOrderFilled() {
        const profit = (this.sellPrice - this.buyPrice) * this.actualQuantity;
        this.state = 'IDLE';
        this.buyOrderId = null;
        this.sellOrderId = null;
        this.lockedAmount = 0;
        this.costBasis = 0;
        this.actualQuantity = 0;
        this.sellRetryCount = 0;    // ✅ 重置重试计数
        this.lastSellAttempt = 0;   // ✅ 重置时间戳
        return profit;
    }
    
    getStateText() {
        const stateMap = {
            'IDLE': '待命',
            'PLACING_BUY': '下买单中',
            'BUY_ACTIVE': '等待买入',
            'BOUGHT': '已买入',
            'PLACING_SELL': '下卖单中',
            'SELL_ACTIVE': '等待卖出',
            'STUCK': '⚠️异常持仓'
        };
        return stateMap[this.state] || this.state;
    }

    getStateClass() {
        const classMap = {
            'IDLE': 'status-waiting',
            'PLACING_BUY': 'status-placing-buy',
            'BUY_ACTIVE': 'status-active-buy',
            'BOUGHT': 'status-completed',
            'PLACING_SELL': 'status-placing-sell',
            'SELL_ACTIVE': 'status-active-sell',
            'STUCK': 'status-error'
        };
        return classMap[this.state] || 'status-waiting';
    }
}

// 交易统计管理器
class TradingStats {
    constructor() {
        this.startTime = null;
        this.totalBuyVolume = 0;      // 总买入金额 (USDT) - 仅统计用
        this.totalSellVolume = 0;     // 总卖出金额 (USDT) - 仅统计用
        this.totalBuyFees = 0;        // 买入手续费
        this.totalSellFees = 0;       // 卖出手续费
        this.realizedProfit = 0;      // 已实现利润（卖出收入 - 买入成本）
        this.buyCount = 0;             // 买入次数
        this.sellCount = 0;            // 卖出次数
        this.runtimeUpdateInterval = null;
    }

    start() {
        this.startTime = Date.now();
        this.totalBuyVolume = 0;
        this.totalSellVolume = 0;
        this.totalBuyFees = 0;
        this.totalSellFees = 0;
        this.realizedProfit = 0;
        this.buyCount = 0;
        this.sellCount = 0;

        // 启动运行时间更新定时器（每秒更新）
        if (this.runtimeUpdateInterval) clearInterval(this.runtimeUpdateInterval);
        this.runtimeUpdateInterval = setInterval(() => this.updateRuntimeDisplay(), 1000);

        this.updateDisplay();
        addMessage('📊 统计系统已启动', 'success');
    }

    stop() {
        if (this.runtimeUpdateInterval) {
            clearInterval(this.runtimeUpdateInterval);
            this.runtimeUpdateInterval = null;
        }
        this.updateDisplay();
        addMessage('📊 统计系统已停止', 'info');
    }

    reset() {
        this.startTime = null;
        this.totalBuyVolume = 0;
        this.totalSellVolume = 0;
        this.totalBuyFees = 0;
        this.totalSellFees = 0;
        this.realizedProfit = 0;
        this.buyCount = 0;
        this.sellCount = 0;
        if (this.runtimeUpdateInterval) {
            clearInterval(this.runtimeUpdateInterval);
            this.runtimeUpdateInterval = null;
        }
        this.updateDisplay();
    }

    /**
     * 记录买入交易
     * @param {number} buyPrice - 买入价格
     * @param {number} quantity - 买入数量
     * @returns {number} 买入总成本（含手续费）
     */
    recordBuy(buyPrice, quantity) {
        const volume = buyPrice * quantity;
        const fee = volume * parseFloat(currentFeeRate.takerFeeRate);

        this.totalBuyVolume += volume;
        this.totalBuyFees += fee;
        this.buyCount++;

        this.updateDisplay();

        // 返回实际总成本（买入金额 + 手续费）
        return volume + fee;
    }

    /**
     * 记录卖出交易并计算利润
     * @param {number} sellPrice - 卖出价格
     * @param {number} quantity - 卖出数量
     * @param {number} buyPrice - 买入价格
     */
    recordSell(sellPrice, quantity, buyPrice) {
        const sellVolume = sellPrice * quantity;
        const sellFee = sellVolume * parseFloat(currentFeeRate.takerFeeRate);

        const buyVolume = buyPrice * quantity;
        const buyFee = buyVolume * parseFloat(currentFeeRate.takerFeeRate);

        this.totalSellVolume += sellVolume;
        this.totalSellFees += sellFee;
        this.sellCount++;

        // ✅ 正确计算利润：(卖出金额 - 卖出手续费) - (买入金额 + 买入手续费)
        // 简化为: (卖出金额 - 买入金额) - (买入手续费 + 卖出手续费)
        const grossProfit = sellVolume - buyVolume;  // 毛利润
        const totalFees = buyFee + sellFee;          // 总手续费
        const netProfit = grossProfit - totalFees;    // 净利润

        this.realizedProfit += netProfit;

        this.updateDisplay();
    }

    getRuntime() {
        if (!this.startTime) return 0;
        return Date.now() - this.startTime;
    }

    formatRuntime() {
        const ms = this.getRuntime();
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) {
            return `${days}天 ${hours % 24}时 ${minutes % 60}分 ${seconds % 60}秒`;
        } else if (hours > 0) {
            return `${hours}时 ${minutes % 60}分 ${seconds % 60}秒`;
        } else if (minutes > 0) {
            return `${minutes}分 ${seconds % 60}秒`;
        } else {
            return `${seconds}秒`;
        }
    }

    getTotalVolume() {
        return this.totalBuyVolume + this.totalSellVolume;
    }

    getTotalFees() {
        return this.totalBuyFees + this.totalSellFees;
    }

    getNetProfit() {
        // ✅ realizedProfit 已经扣除了手续费,直接返回
        return this.realizedProfit;
    }

    updateRuntimeDisplay() {
        if (runtimeSpan) {
            runtimeSpan.textContent = this.formatRuntime();
        }
    }

    updateDisplay() {
        if (runtimeSpan) runtimeSpan.textContent = this.formatRuntime();
        if (totalVolumeSpan) totalVolumeSpan.textContent = this.getTotalVolume().toFixed(2);
        if (buyVolumeSpan) buyVolumeSpan.textContent = this.totalBuyVolume.toFixed(2);
        if (sellVolumeSpan) sellVolumeSpan.textContent = this.totalSellVolume.toFixed(2);
        if (feesCostSpan) feesCostSpan.textContent = this.getTotalFees().toFixed(4);
        if (buyCountSpan) buyCountSpan.textContent = this.buyCount;
        if (sellCountSpan) sellCountSpan.textContent = this.sellCount;

        if (netProfitSpan) {
            const netProfit = this.getNetProfit();
            netProfitSpan.textContent = netProfit.toFixed(4);
            // 根据盈亏设置颜色
            if (netProfit > 0) {
                netProfitSpan.style.color = '#10b981'; // 绿色
            } else if (netProfit < 0) {
                netProfitSpan.style.color = '#ef4444'; // 红色
            } else {
                netProfitSpan.style.color = '#6b7280'; // 灰色
            }
        }
    }

    getStatsReport() {
        return {
            runtime: this.formatRuntime(),
            totalVolume: this.getTotalVolume().toFixed(2),
            buyVolume: this.totalBuyVolume.toFixed(2),
            sellVolume: this.totalSellVolume.toFixed(2),
            totalFees: this.getTotalFees().toFixed(4),
            buyCount: this.buyCount,
            sellCount: this.sellCount,
            netProfit: this.getNetProfit().toFixed(4)
        };
    }
}

// 全局实例
let fundManager = null;
let gridLevelManagers = new Map();
let tradingStats = null;

/**
 * 计算当前持仓的浮盈浮亏
 */
function calculateUnrealizedPnL() {
    if (!currentPrice || currentPrice <= 0) {
        return {
            totalCost: 0,
            currentValue: 0,
            unrealizedPnL: 0,
            unrealizedPnLPercent: 0,
            positionCount: 0,
            totalQuantity: 0
        };
    }

    let totalCost = 0;
    let currentValue = 0;
    let positionCount = 0;
    let totalQuantity = 0;

    gridLevelManagers.forEach(level => {
        // 统计所有持仓状态的网格（包括BOUGHT, SELL_ACTIVE, STUCK）
        if (['BOUGHT', 'SELL_ACTIVE', 'STUCK', 'PLACING_SELL'].includes(level.state)) {
            if (level.actualQuantity > 0 && level.costBasis > 0) {
                totalCost += level.costBasis;
                currentValue += level.actualQuantity * currentPrice;
                positionCount++;
                totalQuantity += level.actualQuantity;
            }
        }
    });

    const unrealizedPnL = currentValue - totalCost;
    const unrealizedPnLPercent = totalCost > 0 ? (unrealizedPnL / totalCost) * 100 : 0;

    return {
        totalCost: totalCost,
        currentValue: currentValue,
        unrealizedPnL: unrealizedPnL,
        unrealizedPnLPercent: unrealizedPnLPercent,
        positionCount: positionCount,
        totalQuantity: totalQuantity
    };
}

/**
 * 更新浮盈浮亏显示（异步版本，可选查询实际余额）
 */
async function updateUnrealizedPnLDisplay(useRealBalance = false) {
    let pnl = calculateUnrealizedPnL();

    // ✅ 可选：查询实际账户余额来计算浮盈浮亏
    if (useRealBalance && API_KEY && API_SECRET && instrumentInfo[gridConfig.symbol]) {
        const baseCoin = instrumentInfo[gridConfig.symbol].baseCoin;
        const balance = await getAccountBalance(baseCoin);

        if (balance && balance.total > 0 && currentPrice > 0) {
            // 使用实际余额重新计算
            const actualValue = balance.total * currentPrice;

            // 如果网格有成本记录，用实际数量和网格平均成本计算
            if (pnl.totalCost > 0 && pnl.totalQuantity > 0) {
                const avgCost = pnl.totalCost / pnl.totalQuantity;  // 平均成本价
                const estimatedCost = balance.total * avgCost;      // 估算总成本
                pnl = {
                    totalCost: estimatedCost,
                    currentValue: actualValue,
                    unrealizedPnL: actualValue - estimatedCost,
                    unrealizedPnLPercent: (actualValue - estimatedCost) / estimatedCost * 100,
                    positionCount: balance.total > 0 ? 1 : 0,
                    totalQuantity: balance.total
                };
            } else {
                // 没有成本记录，只显示当前价值
                pnl = {
                    totalCost: 0,
                    currentValue: actualValue,
                    unrealizedPnL: 0,
                    unrealizedPnLPercent: 0,
                    positionCount: balance.total > 0 ? 1 : 0,
                    totalQuantity: balance.total
                };
            }
        }
    }

    if (window.positionCountSpan) window.positionCountSpan.textContent = pnl.positionCount;
    if (window.totalQuantitySpan) window.totalQuantitySpan.textContent = pnl.totalQuantity.toFixed(gridConfig.qtyPrecision || 2);
    if (window.positionCostSpan) window.positionCostSpan.textContent = pnl.totalCost.toFixed(2);
    if (window.positionValueSpan) window.positionValueSpan.textContent = pnl.currentValue.toFixed(2);

    if (window.unrealizedPnlSpan) {
        window.unrealizedPnlSpan.textContent = pnl.unrealizedPnL.toFixed(4);
        window.unrealizedPnlSpan.style.color = pnl.unrealizedPnL >= 0 ? '#00ff7f' : '#ff4d4d';
    }

    if (window.unrealizedPnlPercentSpan) {
        window.unrealizedPnlPercentSpan.textContent = pnl.unrealizedPnLPercent.toFixed(2);
        window.unrealizedPnlPercentSpan.style.color = pnl.unrealizedPnLPercent >= 0 ? '#00ff7f' : '#ff4d4d';
    }
}

// ==================== Utility & API Functions ====================

async function syncServerTime() {
  try {
    const response = await fetch('https://api.bybit.com/v5/market/time');
    const data = await response.json();
    if (data.retCode === 0 && data.result && data.result.timeNano) {
      serverTimeOffset = parseInt(data.result.timeNano) / 1000000 - Date.now();
      return parseInt(data.result.timeNano) / 1000000;
    } else {
      addMessage(`服务器时间同步失败: ${data.retMsg || '未知错误'}`, 'error');
      throw new Error(data.retMsg || '服务器时间同步失败');
    }
  } catch (error) {
    addMessage(`服务器时间同步网络错误: ${error.message}`, 'error');
    throw error;
  }
}

function getAdjustedTimestamp() {
  return Math.floor(Date.now() + serverTimeOffset);
}

async function getCookiesFromBackground(url) {
    return new Promise((resolve, reject) => {
        if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
           return reject(new Error("Chrome runtime 不可用. 无法获取 cookies."));
        }
        chrome.runtime.sendMessage({ action: 'getCookies', url: url }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("获取 cookies 时发生错误:", chrome.runtime.lastError.message);
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (response && response.success) {
                resolve(response.cookieHeader);
            } else {
                reject(new Error(response?.message || "从 background 获取 cookies 失败"));
            }
        });
    });
}

async function getHttpApiSignature(parameters, secret, timestamp, recvWindow) {
    const apiKeyToUse = API_KEY || (apiKeyInput ? apiKeyInput.value.trim() : '');
    const stringToSign = `${timestamp}${apiKeyToUse}${recvWindow}${parameters}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey( 'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'] );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
    return Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getWebSocketAuthSignature(apiSecret, expiresTimestamp) {
    const stringToSign = `GET/realtime${expiresTimestamp}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
    return Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function httpRequest_V5(endpoint, method, reqData = {}, info = "API Request", retries = MAX_RETRIES) {
  const currentApiKey = API_KEY || (apiKeyInput ? apiKeyInput.value.trim() : '');
  const currentApiSecret = API_SECRET || (apiSecretInput ? apiSecretInput.value.trim() : '');

  if (!currentApiKey || !currentApiSecret) {
    addMessage(`${info} 失败: API密钥未配置`, 'error');
    addMessage(`[DEBUG] API Key 来源检查:`, 'debug');
    addMessage(`  - 全局变量 API_KEY: "${API_KEY}" (长度: ${API_KEY.length})`, 'debug');
    addMessage(`  - apiKeyInput 元素: ${apiKeyInput ? '存在' : '不存在'}`, 'debug');
    if (apiKeyInput) {
      addMessage(`  - apiKeyInput.value: "${apiKeyInput.value}" (长度: ${apiKeyInput.value.length})`, 'debug');
    }
    return { success: false, error: 'API密钥未配置', data: null };
  }
  const timestamp = getAdjustedTimestamp().toString();
  const recvWindow = RECV_WINDOW.toString();
  let paramsQueryString = ''; let bodyPayload = '';
  if (method === 'GET') {
    paramsQueryString = Object.keys(reqData).sort().map(key => `${key}=${encodeURIComponent(reqData[key])}`).join('&');
  } else {
    bodyPayload = JSON.stringify(reqData); paramsQueryString = bodyPayload; 
  }
  const signature = await getHttpApiSignature(paramsQueryString, currentApiSecret, timestamp, recvWindow);
  const headers = {
    'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-SIGN': signature, 'X-BAPI-API-KEY': currentApiKey,
    'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': recvWindow,
    'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json'
  };
  let url = `https://api.bybit.com${endpoint}`;
  if (method === 'GET' && paramsQueryString) { url += `?${paramsQueryString}`; }
  try {
    const response = await fetch(url, { method, headers, body: method !== 'GET' ? bodyPayload : undefined });
    const responseData = await response.json();
    if (responseData.retCode === 0) { return { success: true, data: responseData }; } 
    else {
        console.error(`${info} 失败 (V5):`, responseData);
        addMessage(`${info} 失败 (V5): ${responseData.retMsg} (Code: ${responseData.retCode})`, 'error');
        if (retries > 0 && [10001, 10004, 10006, 10002].includes(responseData.retCode)) {
            addMessage(`重试 ${MAX_RETRIES - retries + 1}/${MAX_RETRIES}`, 'info');
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (MAX_RETRIES - retries + 1) ));
            return httpRequest_V5(endpoint, method, reqData, info, retries - 1);
        }
        return { success: false, error: responseData.retMsg, data: responseData };
    }
  } catch (error) {
      console.error(`${info} 网络错误 (V5):`, error);
      addMessage(`${info} 网络错误 (V5): ${error.message}`, 'error');
      if (retries > 0) {
          addMessage(`重试 ${MAX_RETRIES - retries + 1}/${MAX_RETRIES}`, 'info');
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (MAX_RETRIES - retries + 1)));
          return httpRequest_V5(endpoint, method, reqData, info, retries - 1);
      }
      return { success: false, error: error.message, data: null };
  }
}

async function getFeeRate() {
    const result = await httpRequest_V5('/v5/account/fee-rate', 'GET', { category: 'spot' }, '查询交易费率');
    if (result.success && result.data.result && result.data.result.list && result.data.result.list.length > 0) {
        const feeInfo = result.data.result.list[0];
        currentFeeRate = { takerFeeRate: feeInfo.takerFeeRate, makerFeeRate: feeInfo.makerFeeRate };
        if(feeRateSpan) feeRateSpan.textContent = `Taker: ${parseFloat(feeInfo.takerFeeRate) * 100}%, Maker: ${parseFloat(feeInfo.makerFeeRate) * 100}%`;
        addMessage(`费率查询成功: Maker ${currentFeeRate.makerFeeRate}, Taker ${currentFeeRate.takerFeeRate}`, 'success');
    } else {
        addMessage(`费率查询失败: ${result.error || '无数据返回'}`, 'error');
        if(feeRateSpan) feeRateSpan.textContent = "查询失败";
    }
}

async function getInstrumentInfo(symbol) {
    if (!symbol) {
        addMessage('获取交易对信息失败: symbol 未提供', 'error');
        instrumentInfo['DEFAULT'] = instrumentInfo['DEFAULT'] || { tickSize: "0.00001", minOrderQty: 1, maxOrderQty: 1000000, qtyStep: "0.1", baseCoin: 'UNKNOWN', quoteCoin: 'USDT' };
        gridConfig.quotePrecision = (instrumentInfo['DEFAULT'].tickSize.split('.')[1] || '').length;
        gridConfig.qtyPrecision = (instrumentInfo['DEFAULT'].qtyStep.split('.')[1] || '').length;
        return instrumentInfo['DEFAULT'];
    }
    const result = await httpRequest_V5('/v5/market/instruments-info', 'GET', { category: 'spot', symbol: symbol }, `查询交易对信息 ${symbol}`);
    if (result.success && result.data.result && result.data.result.list && result.data.result.list.length > 0) {
        const info = result.data.result.list[0];
        const tickSizeStr = (info.priceFilter && typeof info.priceFilter.tickSize === 'string') ? info.priceFilter.tickSize : "0.00001";
        const qtyStepStr = (info.lotSizeFilter && typeof info.lotSizeFilter.qtyStep === 'string') ? info.lotSizeFilter.qtyStep : "0.1";
        instrumentInfo[symbol] = {
            tickSize: parseFloat(tickSizeStr),
            minOrderQty: (info.lotSizeFilter && parseFloat(info.lotSizeFilter.minOrderQty)) || 0.00001,
            maxOrderQty: (info.lotSizeFilter && parseFloat(info.lotSizeFilter.maxOrderQty)) || 10000000,
            qtyStep: parseFloat(qtyStepStr),
            baseCoin: info.baseCoin || symbol.replace('USDT', ''),
            quoteCoin: info.quoteCoin || 'USDT',
        };
        gridConfig.quotePrecision = (tickSizeStr.split('.')[1] || '').length;
        gridConfig.qtyPrecision = (qtyStepStr.split('.')[1] || '').length;
        addMessage(`交易对信息 ${symbol}: 价格精度 ${gridConfig.quotePrecision}, 数量精度 ${gridConfig.qtyPrecision}`, 'success');
        return instrumentInfo[symbol];
    } else {
        addMessage(`获取交易对信息 ${symbol} 失败: ${result.error || '无数据'}`, 'error');
        gridConfig.quotePrecision = gridConfig.quotePrecision || 5;
        gridConfig.qtyPrecision = gridConfig.qtyPrecision || 1;
        instrumentInfo[symbol] = instrumentInfo[symbol] || { tickSize: 0.00001, minOrderQty: 1, maxOrderQty: 1000000, qtyStep: 0.1, baseCoin: symbol.replace('USDT',''), quoteCoin: 'USDT' };
        return instrumentInfo[symbol];
    }
}

// ==================== 智能响应式网格核心逻辑 ====================

/**
 * 根据当前价格和配置计算网格参数（新算法：根据利润率自动计算区间）
 */
function calculateDynamicGridParams(basePrice) {
    if (!basePrice || basePrice <= 0) {
        addMessage('计算网格参数失败：无效的基准价格', 'error');
        return null;
    }

    // ✅ 新算法：根据网格数量和利润率自动计算价格区间
    // 逻辑：网格数量越多，区间越大；利润率越大，区间越大
    // 公式：价格区间 = 利润率 × 网格数量 × 调整系数
    const profitPercent = gridConfig.profitPercent / 100;
    const gridCount = gridConfig.gridCount;

    // 计算总价格区间（上下对称）
    // 每个网格利润率为 profitPercent，总共 gridCount 个网格
    // 区间 = 利润率 × 网格数量 / 2（因为上下各一半）
    const rangePercent = (profitPercent * gridCount) / 2;

    const upperPrice = basePrice * (1 + rangePercent);
    const lowerPrice = basePrice * (1 - rangePercent);
    const priceRange = upperPrice - lowerPrice;
    const interval = priceRange / gridCount;
    const usdtPerGrid = gridConfig.totalUsdt / gridCount;

    addMessage(`📐 网格参数: 利润率${gridConfig.profitPercent}% × ${gridCount}格 = 区间±${(rangePercent * 100).toFixed(1)}%`, 'debug');

    return {
        centerPrice: basePrice,
        upperPrice: parseFloat(upperPrice.toFixed(gridConfig.quotePrecision)),
        lowerPrice: parseFloat(lowerPrice.toFixed(gridConfig.quotePrecision)),
        interval: parseFloat(interval.toFixed(gridConfig.quotePrecision)),
        usdtPerGrid: parseFloat(usdtPerGrid.toFixed(2))
    };
}

/**
 * 生成网格价格级别（买入价和对应卖出价）
 */
function generateGridLevels(params) {
    const levels = [];
    const profitMultiplier = 1 + (gridConfig.profitPercent / 100);
    
    for (let i = 0; i < gridConfig.gridCount; i++) {
        const buyPrice = parseFloat((params.lowerPrice + params.interval * i).toFixed(gridConfig.quotePrecision));
        const sellPrice = parseFloat((buyPrice * profitMultiplier).toFixed(gridConfig.quotePrecision));
        
        // 确保卖价不超过上限
        if (sellPrice > params.upperPrice) {
            addMessage(`网格${i+1} 卖价${sellPrice}超出上限${params.upperPrice}，跳过`, 'warning');
            continue;
        }
        
        const estimatedQty = params.usdtPerGrid / buyPrice;
        const roundedQty = parseFloat(estimatedQty.toFixed(gridConfig.qtyPrecision));
        
        if (roundedQty > 0) {
            levels.push({
                index: i,
                buyPrice: buyPrice,
                sellPrice: sellPrice,
                quantity: roundedQty,
                profitPercent: gridConfig.profitPercent
            });
        }
    }
    
    return levels;
}

/**
 * 检查价格是否超出重置阈值
 */
function shouldRebalanceGrid(currentPrice) {
    if (!gridConfig.centerPrice || !autoRebalanceEnabled) return false;
    
    const threshold = gridConfig.rebalanceThreshold / 100;
    const upperThreshold = gridConfig.centerPrice * (1 + threshold);
    const lowerThreshold = gridConfig.centerPrice * (1 - threshold);
    
    return currentPrice > upperThreshold || currentPrice < lowerThreshold;
}

/**
 * 重置网格 - 核心功能
 */
async function rebalanceGrid(newCenterPrice, reason = '价格触发') {
    addMessage(`🔄 开始重置网格 - 原因: ${reason}`, 'warning');
    addMessage(`原中心价: ${gridConfig.centerPrice.toFixed(gridConfig.quotePrecision)}, 新中心价: ${newCenterPrice.toFixed(gridConfig.quotePrecision)}`, 'info');
    
    // 1. 撤销所有现有订单
    await cancelAllGridOrders('网格重置');
    
    // 2. 清空订单追踪
    gridOrders.clear();
    activeBuyOrdersPerLevel.clear();
    activeSellOrdersPerLevel.clear();
    
    // 3. 重新计算网格参数
    const params = calculateDynamicGridParams(newCenterPrice);
    if (!params) {
        addMessage('重置失败：无法计算新网格参数', 'error');
        return false;
    }
    
    // 4. 更新配置
    Object.assign(gridConfig, params);
    
    // 5. ✅ 查询实际可用USDT，重新同步资金
    let actualAvailableUsdt = gridConfig.totalUsdt;  // 默认使用初始设置

    if (API_KEY && API_SECRET) {
        const usdtBalance = await getAccountBalance('USDT');
        if (usdtBalance && usdtBalance.available > 0) {
            actualAvailableUsdt = usdtBalance.available;
            addMessage(`💰 查询到实际可用: ${actualAvailableUsdt.toFixed(2)} USDT (原设置: ${gridConfig.totalUsdt})`, 'info');

            // ✅ 更新FundManager使用实际余额
            if (fundManager) {
                fundManager.reset(actualAvailableUsdt);
                addMessage(`💰 资金池已更新为实际余额: ${actualAvailableUsdt.toFixed(2)} USDT`, 'success');
            }

            // ✅ 更新配置中的总金额
            gridConfig.totalUsdt = actualAvailableUsdt;
        }
    }

    // 6. 生成新的价格级别（使用实际资金）
    gridConfig.levels = generateGridLevels(params);

    // 7. 重新初始化网格管理器
    gridLevelManagers.clear();
    const usdtPerGrid = actualAvailableUsdt / gridConfig.gridCount;

    gridConfig.levels.forEach(level => {
        const manager = new GridLevelManager(
            level.index,
            level.buyPrice,
            level.sellPrice,
            level.quantity,
            usdtPerGrid
        );
        gridLevelManagers.set(level.index, manager);
    });

    // 8. 更新UI
    updateGridConfigDisplay();
    renderGridPreviewTable();

    // 9. 增加计数器
    rebalanceCount++;
    if (rebalanceCountSpan) rebalanceCountSpan.textContent = rebalanceCount;

    addMessage(`✅ 网格重置完成! 新范围: ${params.lowerPrice.toFixed(gridConfig.quotePrecision)} - ${params.upperPrice.toFixed(gridConfig.quotePrecision)}`, 'success');
    addMessage(`重置次数: ${rebalanceCount} | 使用资金: ${actualAvailableUsdt.toFixed(2)} USDT`, 'info');

    // 10. 等待一小段时间再开始下单
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return true;
}

/**
 * 撤销所有网格订单 - 完全使用 Cookie 模式，不需要 API Key
 */
async function cancelAllGridOrders(reason = '停止交易') {
    if (gridOrders.size === 0) {
        addMessage('没有需要撤销的订单', 'info');
        return;
    }

    addMessage(`🗑️ [Cookie模式] 开始撤销 ${gridOrders.size} 个订单 - ${reason}`, 'warning');

    const ordersToCancel = Array.from(gridOrders.entries());
    let successCount = 0;
    let failCount = 0;
    let alreadyDoneCount = 0;

    for (const [orderId, orderInfo] of ordersToCancel) {
        try {
            // 使用 Cookie 模式撤销订单
            const result = await cancelOrder_CookieBased(orderInfo.symbol, orderId);

            if (result.success) {
                if (result.alreadyDone) {
                    alreadyDoneCount++;
                } else {
                    successCount++;
                }
            } else {
                failCount++;
            }

        } catch (error) {
            addMessage(`✗ 订单 ${orderId.substring(0, 12)}... 撤销异常: ${error.message}`, 'error');
            failCount++;
        }

        // 无论撤销成功或失败，都清理本地追踪
        gridOrders.delete(orderId);

        // 清理价格级别映射
        if (orderInfo.price) {
            const priceStr = orderInfo.price.toFixed(gridConfig.quotePrecision);
            if (orderInfo.side === 'Buy') {
                activeBuyOrdersPerLevel.delete(priceStr);
            } else if (orderInfo.side === 'Sell') {
                activeSellOrdersPerLevel.delete(priceStr);
            }
        }

        // 避免请求过快
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    // 确保清空所有追踪
    gridOrders.clear();
    activeBuyOrdersPerLevel.clear();
    activeSellOrdersPerLevel.clear();

    // ✅ FIX: 重置所有 GridLevelManager 状态，避免残留"等待买入"等状态
    gridLevelManagers.forEach((level, index) => {
        if (level.state !== 'IDLE') {
            // 如果有锁定资金，释放它
            if (level.state === 'BUY_ACTIVE' || level.state === 'PLACING_BUY') {
                if (fundManager && level.lockedAmount > 0) {
                    fundManager.unlockFromBuy(level.lockedAmount);
                }
            }

            // 重置状态
            level.state = 'IDLE';
            level.buyOrderId = null;
            level.sellOrderId = null;
            level.lockedAmount = 0;
            level.costBasis = 0;
        }
    });

    // 汇总报告
    const totalProcessed = successCount + alreadyDoneCount + failCount;
    addMessage(`📊 撤单统计: 总共 ${totalProcessed} 个订单`, 'info');
    if (successCount > 0) {
        addMessage(`   ✅ 成功撤销: ${successCount} 个`, 'success');
    }
    if (alreadyDoneCount > 0) {
        addMessage(`   ℹ️ 已成交/已取消: ${alreadyDoneCount} 个`, 'info');
    }
    if (failCount > 0) {
        addMessage(`   ❌ 撤销失败: ${failCount} 个`, 'error');
        addMessage(`   💡 失败的订单可能需要手动前往 Bybit 交易所撤销`, 'warning');
    }

    if (failCount === 0) {
        addMessage(`✅ 订单撤销完成: 全部 ${successCount + alreadyDoneCount} 个订单已处理`, 'success');
    } else {
        addMessage(`⚠️ 订单撤销完成: 成功 ${successCount + alreadyDoneCount} 个, 失败 ${failCount} 个`, 'warning');
    }

    // 刷新UI
    renderGridPreviewTable();
}

/**
 * 价格监控 - 检查是否需要重置网格
 */
async function monitorPriceAndRebalance() {
    if (!isGridRunning || !currentPrice || !gridConfig.centerPrice) return;
    
    if (shouldRebalanceGrid(currentPrice)) {
        const deviation = ((currentPrice - gridConfig.centerPrice) / gridConfig.centerPrice * 100).toFixed(2);
        addMessage(`⚠️ 价格偏离中心 ${deviation}%，触发重置阈值`, 'warning');
        
        const success = await rebalanceGrid(currentPrice, `价格偏离${deviation}%`);
        if (success) {
            // 重置后重新开始网格交易
            setTimeout(() => {
                if (isGridRunning) performGridCheck();
            }, 2000);
        }
    }
}

/**
 * 计算并预览网格
 */
async function calculateGridLevels() {
    if (!currentPrice) {
        addMessage('无法计算网格：等待价格数据...', 'warning');
        return;
    }

    // 读取UI配置
    gridConfig.symbol = gridSymbolInput ? gridSymbolInput.value.trim().toUpperCase() : 'NXPCUSDT';
    gridConfig.profitPercent = profitPercentInput ? parseFloat(profitPercentInput.value) : 2.5;
    gridConfig.gridCount = gridCountInput ? parseInt(gridCountInput.value) : 10;
    gridConfig.capitalPercent = capitalPercentInput ? parseFloat(capitalPercentInput.value) : 100;
    gridConfig.rebalanceThreshold = rebalanceThresholdInput ? parseFloat(rebalanceThresholdInput.value) : 15;

    // ✅ 查询账户USDT余额并计算实际投入
    let accountBalance = 100;  // 默认值
    if (API_KEY && API_SECRET) {
        const usdtBalance = await getAccountBalance('USDT');
        if (usdtBalance && usdtBalance.available > 0) {
            accountBalance = usdtBalance.available;
            addMessage(`💰 查询到账户USDT: ${accountBalance.toFixed(2)}`, 'info');
        } else {
            addMessage(`⚠️ 无法查询USDT余额，使用默认值 ${accountBalance}`, 'warning');
        }
    } else {
        addMessage(`⚠️ 未配置API，无法查询余额，使用默认值 ${accountBalance}`, 'warning');
    }

    // ✅ 根据百分比计算实际投入
    gridConfig.totalUsdt = accountBalance * (gridConfig.capitalPercent / 100);
    addMessage(`💵 实际投入: ${gridConfig.totalUsdt.toFixed(2)} USDT (${gridConfig.capitalPercent}% × ${accountBalance.toFixed(2)})`, 'success');

    // 计算网格参数
    const params = calculateDynamicGridParams(currentPrice);
    if (!params) return;

    // 更新配置
    Object.assign(gridConfig, params);

    // 生成价格级别
    gridConfig.levels = generateGridLevels(params);

    // 初始化GridLevelManager
    gridLevelManagers.clear();
    const usdtPerGrid = gridConfig.totalUsdt / gridConfig.gridCount;

    gridConfig.levels.forEach(level => {
        const manager = new GridLevelManager(
            level.index,
            level.buyPrice,
            level.sellPrice,
            level.quantity,
            usdtPerGrid
        );
        gridLevelManagers.set(level.index, manager);
    });
    
    // 初始化资金管理器
    if (!fundManager) {
        fundManager = new FundManager(gridConfig.totalUsdt);
    } else {
        fundManager.reset(gridConfig.totalUsdt);
    }
    
    // 更新UI
    updateGridConfigDisplay();
    renderGridPreviewTable();
    
    addMessage(`✓ 网格计算完成: ${gridConfig.levels.length} 个交易对`, 'success');
    addMessage(`💰 资金池初始化: 总 ${gridConfig.totalUsdt.toFixed(2)} USDT`, 'info');
}

/**
 * 更新网格配置显示
 */
function updateGridConfigDisplay() {
    if (usdtPerGridSpan) usdtPerGridSpan.textContent = gridConfig.usdtPerGrid.toFixed(2);
    if (priceIntervalSpan) priceIntervalSpan.textContent = gridConfig.interval.toFixed(gridConfig.quotePrecision);
    if (currentUpperPriceSpan) currentUpperPriceSpan.textContent = gridConfig.upperPrice.toFixed(gridConfig.quotePrecision);
    if (currentLowerPriceSpan) currentLowerPriceSpan.textContent = gridConfig.lowerPrice.toFixed(gridConfig.quotePrecision);
    if (gridCenterPriceSpan) gridCenterPriceSpan.textContent = gridConfig.centerPrice.toFixed(gridConfig.quotePrecision);
}

/**
 * 渲染网格预览表格
 */
function renderGridPreviewTable() {
    if (!gridPreviewTableBody) return;
    
    gridPreviewTableBody.innerHTML = '';
    
    if (gridLevelManagers.size === 0) {
        gridPreviewTableBody.innerHTML = '<tr><td colspan="5" style="text-align:center;">暂无网格数据</td></tr>';
        return;
    }
    
    gridLevelManagers.forEach(level => {
        const row = document.createElement('tr');
        const profitPercent = ((level.sellPrice - level.buyPrice) / level.buyPrice * 100).toFixed(2);
        
        row.innerHTML = `
            <td>${level.index + 1}</td>
            <td>${level.buyPrice.toFixed(gridConfig.quotePrecision)}</td>
            <td>${level.sellPrice.toFixed(gridConfig.quotePrecision)}</td>
            <td>${profitPercent}%</td>
            <td class="${level.getStateClass()}">${level.getStateText()}</td>
        `;
        
        gridPreviewTableBody.appendChild(row);
    });
}

// ==================== Cookie下单和撤单函数 ====================

async function placeGridOrder_CookieBased(symbol, side, price, quantity, orderLinkId) {
    addMessage(`Cookie下单: ${side} ${quantity} @ ${price}`, 'info');
    try {
        const cookieHeader = await getCookiesFromBackground("https://www.bybit.com");
        if (!cookieHeader) throw new Error("未能获取到 Cookie。");

        const formData = new URLSearchParams();
        formData.append('symbol_id', symbol);
        formData.append('side', side.toLowerCase());
        formData.append('type', 'limit');
        formData.append('price', price.toString());
        formData.append('quantity', quantity.toString());
        formData.append('time_in_force', 'gtc');
        formData.append('client_order_id', orderLinkId);

        const headers = {
            'accept': 'application/json',
            'accept-language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'cookie': cookieHeader,
            'origin': 'https://www.bybit.com',
            'referer': `https://www.bybit.com/zh-TW/trade/spot/${symbol.replace('USDT','/USDT')}`,
            'platform': 'pc',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        };

        const response = await fetch('https://www.bybit.com/x-api/spot/api/order/create', {
            method: 'POST',
            headers: headers,
            body: formData.toString()
        });

        const data = await response.json();

        if (data && data.ret_code === 0 && data.result) {
            const returnedOrderId = data.result.order_id || data.result.orderId;
            addMessage(`✓ Cookie下单成功: ${side} @ ${price} (ID: ${returnedOrderId})`, 'success');
            return {
                success: true,
                data: {
                    orderId: returnedOrderId || orderLinkId,
                    orderLinkId: orderLinkId
                }
            };
        } else {
            addMessage(`✗ Cookie下单失败: ${data.ret_msg || '未知错误'}`, 'error');
            return { success: false, error: data.ret_msg || '下单失败' };
        }
    } catch (error) {
        addMessage(`✗ Cookie下单异常: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

/**
 * Cookie模式撤销订单 - 不需要API Key权限
 */
async function cancelOrder_CookieBased(symbol, orderId) {
    addMessage(`[Cookie撤单] 尝试撤销订单: ${orderId.substring(0, 12)}...`, 'info');
    try {
        const cookieHeader = await getCookiesFromBackground("https://www.bybit.com");
        if (!cookieHeader) throw new Error("未能获取到 Cookie");

        const formData = new URLSearchParams();
        formData.append('symbol_id', symbol);
        formData.append('order_id', orderId);

        const headers = {
            'accept': 'application/json',
            'accept-language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'cookie': cookieHeader,
            'origin': 'https://www.bybit.com',
            'referer': `https://www.bybit.com/zh-TW/trade/spot/${symbol.replace('USDT','/USDT')}`,
            'platform': 'pc',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        };

        const response = await fetch('https://www.bybit.com/x-api/spot/api/order/cancel', {
            method: 'POST',
            headers: headers,
            body: formData.toString()
        });

        const data = await response.json();

        if (data && data.ret_code === 0) {
            addMessage(`✓ Cookie撤单成功: ${orderId.substring(0, 12)}...`, 'success');
            return { success: true, data: data };
        } else if (data && (data.ret_code === 170213 || data.ret_code === 170106)) {
            // 订单已成交或已取消
            addMessage(`✓ 订单 ${orderId.substring(0, 12)}... 已成交/已取消`, 'info');
            return { success: true, data: data, alreadyDone: true };
        } else {
            addMessage(`✗ Cookie撤单失败: ${data.ret_msg || '未知错误'} (Code: ${data.ret_code})`, 'error');
            return { success: false, error: data.ret_msg || '撤单失败', retCode: data.ret_code };
        }
    } catch (error) {
        addMessage(`✗ Cookie撤单异常: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

// ==================== 网格交易执行逻辑 ====================

async function startGridTrading() {
    if (isGridRunning) {
        addMessage('网格已在运行中', 'warning');
        return;
    }

    // ✅ 互斥检查：禁止与速刷模式同时运行
    if (isBrushRunning) {
        addMessage('❌ 速刷模式正在运行，请先停止速刷模式', 'error');
        return;
    }

    if (!currentPrice) {
        addMessage('等待价格数据...', 'warning');
        return;
    }

    // ✅ 检查 API Key 配置（可选）
    const apiKeyToUse = API_KEY || (apiKeyInput ? apiKeyInput.value.trim() : '');
    const apiSecretToUse = API_SECRET || (apiSecretInput ? apiSecretInput.value.trim() : '');

    if (!apiKeyToUse || !apiSecretToUse) {
        addMessage('ℹ️ 提示: 未配置 API Key/Secret', 'info');
        addMessage('✓ Cookie 模式已启用: 下单、撤单均无需 API Key', 'success');
        addMessage('✓ 将使用轮询方式监控订单状态', 'success');
        addMessage('💡 如需 WebSocket 实时监控，可在"参数设置"配置 API 凭证', 'info');
    } else {
        addMessage(`✓ API Key 已配置: ${apiKeyToUse.substring(0, 8)}...`, 'success');
        addMessage(`✓ 将启用 WebSocket 实时订单监控`, 'success');
    }
    
    // 读取配置
    checkIntervalSeconds = checkIntervalInput ? parseInt(checkIntervalInput.value) : 10;
    autoRebalanceEnabled = autoRebalanceCheckbox ? autoRebalanceCheckbox.checked : true;

    // 🛡️ 读取止损配置
    gridConfig.gridStoplossEnabled = gridStoplossEnabledCheckbox ? gridStoplossEnabledCheckbox.checked : true;
    gridConfig.gridStoplossPercent = gridStoplossPercentInput ? parseFloat(gridStoplossPercentInput.value) : 5;
    gridConfig.totalStoplossEnabled = totalStoplossEnabledCheckbox ? totalStoplossEnabledCheckbox.checked : true;
    gridConfig.totalStoplossUsdt = totalStoplossUsdtInput ? parseFloat(totalStoplossUsdtInput.value) : 10;

    // 🛡️ 重置止损统计
    stoplossTriggerCount = 0;
    totalStoplossTriggered = false;
    if (stoplossTriggerCountSpan) stoplossTriggerCountSpan.textContent = '0';
    if (totalStoplossStatusSpan) {
        totalStoplossStatusSpan.textContent = '未触发';
        totalStoplossStatusSpan.style.color = '#6b7280';
    }

    // 计算初始网格
    await calculateGridLevels();

    if (gridConfig.levels.length === 0) {
        addMessage('网格计算失败，无法启动', 'error');
        return;
    }

    // ✅ 启动前检查实际USDT余额
    if (apiKeyToUse && apiSecretToUse) {
        const usdtBalance = await getAccountBalance('USDT');
        if (usdtBalance) {
            const actualUsdt = usdtBalance.available;
            addMessage(`💰 交易所实际可用 USDT: ${actualUsdt.toFixed(2)}`, 'info');
            addMessage(`📊 程序设置投入 USDT: ${gridConfig.totalUsdt.toFixed(2)}`, 'info');

            if (actualUsdt < gridConfig.totalUsdt * 0.5) {
                addMessage(`⚠️ 警告: 实际余额(${actualUsdt.toFixed(2)}) 远小于设置金额(${gridConfig.totalUsdt})`, 'error');
                addMessage(`💡 建议: 调整"投入USDT"为 ${actualUsdt.toFixed(2)} 或向账户充值`, 'warning');

                if (!confirm(`实际余额不足！\n\n交易所余额: ${actualUsdt.toFixed(2)} USDT\n程序设置: ${gridConfig.totalUsdt} USDT\n\n继续运行可能导致大量下单失败。\n\n是否仍要启动？`)) {
                    addMessage('已取消启动', 'info');
                    return;
                }
            } else if (actualUsdt < gridConfig.totalUsdt) {
                addMessage(`ℹ️ 提示: 实际余额(${actualUsdt.toFixed(2)}) 略小于设置(${gridConfig.totalUsdt})`, 'warning');
            }
        }
    } else {
        addMessage(`⚠️ 未配置API无法查询实际余额，请确保账户有足够USDT`, 'warning');
    }

    isGridRunning = true;
    rebalanceCount = 0;
    updateGridUIState();

    // ✅ 初始化并启动统计系统
    if (!tradingStats) {
        tradingStats = new TradingStats();
    }
    tradingStats.start();

    addMessage(`🚀 智能响应式网格交易已启动!`, 'success');
    addMessage(`交易对: ${gridConfig.symbol}`, 'info');
    addMessage(`网格数量: ${gridConfig.gridCount}格`, 'info');
    addMessage(`利润设置: ${gridConfig.profitPercent}%`, 'info');
    addMessage(`资金使用: ${gridConfig.capitalPercent}% (${gridConfig.totalUsdt.toFixed(2)} USDT)`, 'info');
    addMessage(`重置阈值: ${gridConfig.rebalanceThreshold}%`, 'info');
    addMessage(`自动重置: ${autoRebalanceEnabled ? '开启' : '关闭'}`, 'info');
    addMessage(`🛡️ === 止损策略 ===`, 'warning');
    addMessage(`🛡️ 每格止损: ${gridConfig.gridStoplossEnabled ? '开启 ' + gridConfig.gridStoplossPercent + '% (单格亏损超过此值立即止损)' : '关闭'}`, gridConfig.gridStoplossEnabled ? 'warning' : 'info');
    addMessage(`🛡️ 整体止损: ${gridConfig.totalStoplossEnabled ? '开启 ' + gridConfig.totalStoplossUsdt + ' USDT (总亏损超过此值停止网格)' : '关闭'}`, gridConfig.totalStoplossEnabled ? 'warning' : 'info');
    addMessage(`🛡️ 止损方式: 当前价-1% 限价单快速成交`, 'info');
    
    // 启动网格检查定时器
    gridCheckInterval = setInterval(() => performGridCheck(), checkIntervalSeconds * 1000);

    // 启动价格监控
    priceMonitorInterval = setInterval(() => monitorPriceAndRebalance(), checkIntervalSeconds * 1000);

    // ✅ FIX: 无论如何都启动订单轮询作为备用机制
    // 原因：即使 WebSocket 连接，也可能因为 API Key 未配置而无法接收订单更新
    addMessage(`启动订单轮询备用机制 (每15秒)`, 'info');
    orderPollingInterval = setInterval(() => pollOrderStatus(), 15000);

    // 延迟2秒后执行第一次检查
    setTimeout(() => {
        if (isGridRunning) performGridCheck();
    }, 2000);
}

async function stopGridTrading(cancelOrders = true) {
    if (!isGridRunning && gridOrders.size === 0) {
        addMessage('网格未在运行', 'info');
        return;
    }

    addMessage('⏹ 正在停止网格交易...', 'warning');

    isGridRunning = false;

    // 停止定时器
    if (gridCheckInterval) {
        clearInterval(gridCheckInterval);
        gridCheckInterval = null;
        addMessage('✓ 已停止网格检查定时器', 'info');
    }

    if (priceMonitorInterval) {
        clearInterval(priceMonitorInterval);
        priceMonitorInterval = null;
        addMessage('✓ 已停止价格监控定时器', 'info');
    }

    if (orderPollingInterval) {
        clearInterval(orderPollingInterval);
        orderPollingInterval = null;
        addMessage('✓ 已停止订单轮询定时器', 'info');
    }

    // 撤销订单
    if (cancelOrders) {
        const orderCount = gridOrders.size;
        if (orderCount > 0) {
            addMessage(`📋 检测到 ${orderCount} 个未完成订单，开始撤销...`, 'warning');
            await cancelAllGridOrders('停止交易');
        } else {
            addMessage('✓ 没有需要撤销的订单', 'info');
        }
    } else {
        addMessage('⚠️ 跳过撤销订单（保留现有订单）', 'warning');
    }

    // ✅ 停止统计系统并显示最终报告
    if (tradingStats) {
        tradingStats.stop();
        const report = tradingStats.getStatsReport();
        addMessage('📊 === 交易统计报告 ===', 'info');
        addMessage(`   运行时间: ${report.runtime}`, 'info');
        addMessage(`   交易总量: ${report.totalVolume} USDT`, 'info');
        addMessage(`   买入量: ${report.buyVolume} USDT (${report.buyCount}次)`, 'info');
        addMessage(`   卖出量: ${report.sellVolume} USDT (${report.sellCount}次)`, 'info');
        addMessage(`   手续费: ${report.totalFees} USDT`, 'info');
        addMessage(`   净利润: ${report.netProfit} USDT`, report.netProfit >= 0 ? 'success' : 'error');
    }

    updateGridUIState();
    addMessage('✅ 网格交易已完全停止', 'success');
}

async function forceRebalanceGrid() {
    if (!isGridRunning) {
        addMessage('请先启动网格交易', 'warning');
        return;
    }
    
    if (!currentPrice) {
        addMessage('无法获取当前价格', 'error');
        return;
    }
    
    addMessage('手动触发网格重置...', 'info');
    const success = await rebalanceGrid(currentPrice, '手动触发');
    
    if (success) {
        setTimeout(() => {
            if (isGridRunning) performGridCheck();
        }, 2000);
    }
}

/**
 * 🛡️ 止损检查函数（严格执行版）
 */
async function checkStoploss() {
    if (!currentPrice || currentPrice <= 0) {
        return { hasStoploss: false, stoppedGrid: false };
    }

    let stoplossCount = 0;
    let stoppedGrid = false;

    // ========== 1. 检查每格止损 ==========
    if (gridConfig.gridStoplossEnabled) {
        const stoplossPriceThreshold = gridConfig.gridStoplossPercent / 100;

        // ✅ 使用 for...of 替代 forEach，确保 await 生效
        for (const [index, level] of gridLevelManagers.entries()) {
            // 只检查持仓状态的网格
            if (['BOUGHT', 'SELL_ACTIVE', 'STUCK', 'PLACING_SELL'].includes(level.state)) {
                if (level.actualQuantity > 0 && level.costBasis > 0) {
                    // 计算当前亏损比例
                    const avgBuyPrice = level.costBasis / level.actualQuantity;
                    const currentValue = level.actualQuantity * currentPrice;
                    const lossPercent = (currentValue - level.costBasis) / level.costBasis;

                    // 如果亏损超过止损线
                    if (lossPercent < -stoplossPriceThreshold) {
                        const lossAmount = level.costBasis - currentValue;
                        addMessage(`🛡️ L${level.index + 1} 触发止损! 买入价:${avgBuyPrice.toFixed(gridConfig.quotePrecision)} 当前价:${currentPrice.toFixed(gridConfig.quotePrecision)} 亏损:${(lossPercent * 100).toFixed(2)}%`, 'error');

                        // ✅ 执行止损卖出，并等待完成
                        const success = await performStoplossSell(level, lossAmount);
                        if (success) {
                            stoplossCount++;
                        }

                        // ✅ 避免同时下多个止损单，每次只处理一个
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
        }

        if (stoplossCount > 0) {
            addMessage(`🛡️ 本轮触发 ${stoplossCount} 个网格止损`, 'warning');
        }
    }

    // ========== 2. 检查整体止损 ==========
    if (gridConfig.totalStoplossEnabled && !totalStoplossTriggered) {
        // 计算总盈亏 = 已实现利润 + 浮盈浮亏
        const pnl = calculateUnrealizedPnL();
        const realizedProfit = tradingStats ? tradingStats.realizedProfit : 0;
        const totalPnL = realizedProfit + pnl.unrealizedPnL;

        // ✅ 每次都显示总盈亏，方便监控
        const lossDisplay = totalPnL < 0 ? `亏损 ${Math.abs(totalPnL).toFixed(2)}` : `盈利 ${totalPnL.toFixed(2)}`;
        addMessage(`💰 当前总盈亏: ${lossDisplay} USDT (已实现:${realizedProfit.toFixed(2)}, 浮盈:${pnl.unrealizedPnL.toFixed(2)}) | 止损线:-${gridConfig.totalStoplossUsdt}`, totalPnL < -gridConfig.totalStoplossUsdt * 0.8 ? 'warning' : 'debug');

        // 如果总亏损超过止损线
        if (totalPnL < -gridConfig.totalStoplossUsdt) {
            addMessage(`🚨 触发整体止损! 总盈亏:${totalPnL.toFixed(2)} USDT 止损线:-${gridConfig.totalStoplossUsdt} USDT`, 'error');

            totalStoplossTriggered = true;
            stoppedGrid = true;

            if (totalStoplossStatusSpan) {
                totalStoplossStatusSpan.textContent = '已触发';
                totalStoplossStatusSpan.style.color = '#ff4d4d';
            }

            // ✅ 停止网格交易，并等待完成
            addMessage(`🛑 整体止损触发，停止网格交易...`, 'error');
            await stopGridTrading(true);  // 撤销所有订单
        }
    }

    return { hasStoploss: stoplossCount > 0, stoppedGrid: stoppedGrid };
}

/**
 * 🛡️ 执行止损卖出（严格版）
 */
async function performStoplossSell(level, lossAmount) {
    // ✅ 如果已经有卖单在途（包括止损单），先撤销
    if (level.sellOrderId && gridOrders.has(level.sellOrderId)) {
        addMessage(`⚠️ L${level.index + 1} 撤销原卖单，准备止损卖出`, 'warning');
        await cancelOrder_CookieBased(gridConfig.symbol, level.sellOrderId);
        gridOrders.delete(level.sellOrderId);

        // 清理订单映射
        const sellPriceStr = level.sellPrice.toFixed(gridConfig.quotePrecision);
        activeSellOrdersPerLevel.delete(sellPriceStr);

        level.sellOrderId = null;
        level.state = 'BOUGHT';
    }

    // ✅ 查询实际余额确保有币可卖
    if (API_KEY && API_SECRET && instrumentInfo[gridConfig.symbol]) {
        const baseCoin = instrumentInfo[gridConfig.symbol].baseCoin;
        const balance = await getAccountBalance(baseCoin);

        if (!balance || balance.available <= 0) {
            addMessage(`❌ L${level.index + 1} 止损失败: 账户余额为0或查询失败`, 'error');
            return false;
        }

        if (balance.available < level.actualQuantity) {
            addMessage(`⚠️ L${level.index + 1} 止损: 实际余额(${balance.available}) < 持仓量(${level.actualQuantity})，使用实际余额`, 'warning');
            level.actualQuantity = balance.available;
        }
    }

    // ✅ 使用当前价格-1%作为止损价（更激进，确保快速成交）
    const stoplossPrice = parseFloat((currentPrice * 0.99).toFixed(gridConfig.quotePrecision));
    const sellQuantity = level.actualQuantity;
    const clientOrderId = `STOPLOSS_${gridConfig.symbol}_${level.index}_${Date.now()}`;

    addMessage(`🛡️ L${level.index + 1} 执行止损: 价格${stoplossPrice} 数量${sellQuantity.toFixed(gridConfig.qtyPrecision)}`, 'warning');

    try {
        const result = await placeGridOrder_CookieBased(
            gridConfig.symbol,
            'Sell',
            stoplossPrice,
            sellQuantity,
            clientOrderId
        );

        if (result.success && result.data) {
            const orderId = result.data.orderId;

            // 标记为止损订单
            gridOrders.set(orderId, {
                levelIndex: level.index,
                side: 'Sell',
                price: stoplossPrice,
                quantity: sellQuantity,
                clientOrderId: clientOrderId,
                costBasis: level.costBasis,
                symbol: gridConfig.symbol,
                status: 'New',
                isStoploss: true  // ✅ 标记为止损订单
            });

            level.state = 'SELL_ACTIVE';
            level.sellOrderId = orderId;

            stoplossTriggerCount++;
            if (stoplossTriggerCountSpan) {
                stoplossTriggerCountSpan.textContent = stoplossTriggerCount;
            }

            addMessage(`✅ L${level.index + 1} 止损卖单已下 @ ${stoplossPrice} x ${sellQuantity.toFixed(gridConfig.qtyPrecision)}`, 'success');

            // 记录止损统计
            if (tradingStats) {
                // 止损也算卖出统计，但利润是负的
                tradingStats.recordSell(stoplossPrice, sellQuantity, level.buyPrice);
            }

            renderGridPreviewTable();
            return true;  // ✅ 返回成功
        } else {
            addMessage(`❌ L${level.index + 1} 止损卖单失败: ${result.error}`, 'error');
            return false;  // ✅ 返回失败
        }
    } catch (error) {
        addMessage(`❌ L${level.index + 1} 止损异常: ${error.message}`, 'error');
        return false;  // ✅ 返回失败
    }
}

/**
 * 执行网格检查和订单放置
 */
async function performGridCheck() {
    if (!isGridRunning) return;
    if (isExecutingGridCheck) {
        return; // 防止并发
    }

    isExecutingGridCheck = true;

    try {
        // 🛡️ 步骤0: 止损检查（最高优先级，严格执行）
        const stoplossResult = await checkStoploss();

        // 如果整体止损已触发，立即停止所有操作
        if (stoplossResult.stoppedGrid || totalStoplossTriggered) {
            addMessage(`🛑 整体止损已触发，停止网格检查`, 'error');
            isExecutingGridCheck = false;
            return;
        }

        // 如果有网格止损触发，暂停本轮其他操作，优先处理止损
        if (stoplossResult.hasStoploss) {
            addMessage(`🛡️ 本轮有止损触发，跳过买卖单操作`, 'warning');
            isExecutingGridCheck = false;
            return;
        }

        // 步骤1: 优先处理已买入但未下卖单的（包括STUCK状态）
        const levelsNeedSell = [];
        gridLevelManagers.forEach(level => {
            if (level.state === 'BOUGHT' || level.state === 'STUCK') {
                levelsNeedSell.push(level);
            }
        });
        
        if (levelsNeedSell.length > 0) {
            const retryInfo = levelsNeedSell.filter(l => l.sellRetryCount > 0).length;
            if (retryInfo > 0) {
                addMessage(`📤 发现 ${levelsNeedSell.length} 个待下卖单 (${retryInfo}个重试中)`, 'info');
            } else {
                addMessage(`📤 发现 ${levelsNeedSell.length} 个待下卖单`, 'info');
            }

            for (const level of levelsNeedSell) {
                await placeSellOrder(level);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        
        // 步骤2: 下买单
        const levelsNeedBuy = [];
        gridLevelManagers.forEach(level => {
            if (level.state === 'IDLE') {
                // 价格合适才加入
                if (currentPrice && level.buyPrice < currentPrice * 0.998) {
                    levelsNeedBuy.push(level);
                }
            }
        });
        
        // 按价格从低到高排序
        levelsNeedBuy.sort((a, b) => a.buyPrice - b.buyPrice);
        
        let buyOrdersPlaced = 0;
        for (const level of levelsNeedBuy) {
            const available = fundManager.getAvailableForOrders();
            
            if (available < level.usdtAmount) {
                if (buyOrdersPlaced === 0) {
                    addMessage(`💰 可用资金 ${available.toFixed(2)} USDT 不足`, 'debug');
                }
                break;
            }
            
            const success = await placeBuyOrder(level);
            if (success) buyOrdersPlaced++;
            
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        
        if (buyOrdersPlaced > 0 || levelsNeedSell.length > 0) {
            addMessage(`✓ 本轮: 买${buyOrdersPlaced}个, 卖${levelsNeedSell.length}个`, 'success');
            logFundStatus();
        }
        
        renderGridPreviewTable();
        
    } finally {
        isExecutingGridCheck = false;
    }
}

/**
 * 下买单
 */
async function placeBuyOrder(level) {
    if (!level.prepareForBuy()) return false;

    // 锁定资金
    if (!fundManager.lockForBuy(level.usdtAmount)) {
        level.buyOrderFailed();
        return false;
    }

    level.lockedAmount = level.usdtAmount;

    try {
        const clientOrderId = `BUY_${gridConfig.symbol}_${level.buyPrice}_${Date.now()}`;

        const result = await placeGridOrder_CookieBased(
            gridConfig.symbol,
            'Buy',
            level.buyPrice,
            level.quantity,
            clientOrderId
        );

        if (result.success && result.data) {
            const orderId = result.data.orderId;
            level.buyOrderPlaced(orderId);

            gridOrders.set(orderId, {
                levelIndex: level.index,
                side: 'Buy',
                price: level.buyPrice,
                quantity: level.quantity,
                clientOrderId: clientOrderId,
                symbol: gridConfig.symbol,
                status: 'New'
            });

            const buyPriceStr = level.buyPrice.toFixed(gridConfig.quotePrecision);
            activeBuyOrdersPerLevel.set(buyPriceStr, orderId);

            addMessage(`✓ 买单: L${level.index + 1} @ ${level.buyPrice} | 状态: ${level.getStateText()}`, 'success');
            return true;
        } else {
            fundManager.unlockFromBuy(level.usdtAmount);
            level.lockedAmount = 0;
            level.buyOrderFailed();

            // ✅ 如果是余额不足，给出明确提示
            if (result.error && result.error.includes('Insufficient')) {
                addMessage(`❌ L${level.index + 1} 买单失败: 交易所USDT余额不足 (需要${level.usdtAmount.toFixed(2)} USDT)`, 'error');
            }

            return false;
        }
    } catch (error) {
        fundManager.unlockFromBuy(level.usdtAmount);
        level.lockedAmount = 0;
        level.buyOrderFailed();
        addMessage(`✗ 买单异常: ${error.message}`, 'error');
        return false;
    }
}

/**
 * 下卖单（优化版：依赖prepareForSell的时间控制）
 */
async function placeSellOrder(level) {
    // ✅ prepareForSell 已经确保了足够的等待时间（买入后10秒，重试间隔5秒）
    if (!level.prepareForSell()) {
        return false;
    }

    try {
        // ✅ 使用实际成交数量而非预设数量
        let sellQuantity = level.actualQuantity > 0 ? level.actualQuantity : level.quantity;

        // ✅ 每次尝试卖出前都查询实际余额（如果配置了API）
        if (API_KEY && API_SECRET && instrumentInfo[gridConfig.symbol]) {
            const baseCoin = instrumentInfo[gridConfig.symbol].baseCoin;
            const balance = await getAccountBalance(baseCoin);

            if (balance && balance.available > 0) {
                addMessage(`🔍 L${level.index + 1} 账户实际可用: ${balance.available.toFixed(gridConfig.qtyPrecision)} ${baseCoin}`, 'debug');

                // 如果实际余额小于要卖出的数量
                if (balance.available < sellQuantity) {
                    // ✅ 如果余额为0或极小，说明币还没到账，延长等待
                    if (balance.available < sellQuantity * 0.1) {
                        addMessage(`⚠️ L${level.index + 1} 余额严重不足(${balance.available.toFixed(2)} < ${sellQuantity}), 币可能未到账，等待下次检查`, 'warning');
                        level.sellOrderFailed();
                        return false;
                    }

                    // 根据qtyStep调整数量
                    const qtyStep = instrumentInfo[gridConfig.symbol].qtyStep || 0.1;
                    const adjustedQty = Math.floor(balance.available / qtyStep) * qtyStep;
                    const decimalPlaces = qtyStep.toString().includes('.') ? qtyStep.toString().split('.')[1].length : 0;
                    const finalQty = parseFloat(adjustedQty.toFixed(decimalPlaces));

                    if (finalQty > 0 && finalQty !== sellQuantity) {
                        addMessage(`⚠️ L${level.index + 1} 调整卖出数量: ${sellQuantity} → ${finalQty} (实际余额: ${balance.available})`, 'warning');
                        sellQuantity = finalQty;
                        level.actualQuantity = finalQty;
                    } else if (finalQty <= 0) {
                        addMessage(`❌ L${level.index + 1} 调整后数量仍不足最小下单量，等待下次检查`, 'error');
                        level.sellOrderFailed();
                        return false;
                    }
                }
            } else {
                // 查询失败或余额为0，说明币还没到账
                addMessage(`⚠️ L${level.index + 1} 查询余额失败或余额为0，币可能未到账，等待下次检查`, 'warning');
                level.sellOrderFailed();
                return false;
            }
        } else {
            // ✅ 没有配置API Key时，增加等待时间避免余额不足
            if (level.sellRetryCount <= 3) {
                addMessage(`⚠️ L${level.index + 1} 未配置API无法查询余额，延长等待(重试${level.sellRetryCount}/3)`, 'warning');
                level.sellOrderFailed();
                return false;
            }
            addMessage(`🔍 L${level.index + 1} 准备卖出(无余额查询): quantity=${sellQuantity}`, 'debug');
        }

        const clientOrderId = `SELL_${gridConfig.symbol}_${level.sellPrice}_${Date.now()}`;

        const result = await placeGridOrder_CookieBased(
            gridConfig.symbol,
            'Sell',
            level.sellPrice,
            sellQuantity,
            clientOrderId
        );

        if (result.success && result.data) {
            const orderId = result.data.orderId;
            level.sellOrderPlaced(orderId);

            gridOrders.set(orderId, {
                levelIndex: level.index,
                side: 'Sell',
                price: level.sellPrice,
                quantity: sellQuantity,
                clientOrderId: clientOrderId,
                costBasis: level.costBasis,
                symbol: gridConfig.symbol,
                status: 'New'
            });

            const sellPriceStr = level.sellPrice.toFixed(gridConfig.quotePrecision);
            activeSellOrdersPerLevel.set(sellPriceStr, orderId);

            addMessage(`✓ 卖单: L${level.index + 1} @ ${level.sellPrice} x ${sellQuantity.toFixed(gridConfig.qtyPrecision)}`, 'success');
            return true;
        } else {
            level.sellOrderFailed();

            // ✅ 如果是余额不足，记录日志但不重试（让定时检查处理）
            if (result.error && result.error.includes('Insufficient')) {
                addMessage(`⚠️ L${level.index + 1} 余额不足，将在下次检查时重试`, 'warning');
            }

            return false;
        }
    } catch (error) {
        level.sellOrderFailed();
        addMessage(`✗ 卖单异常: ${error.message}`, 'error');
        return false;
    }
}

/**
 * 资金状态日志
 */
function logFundStatus() {
    if (!fundManager) return;

    const status = fundManager.getStatus();
    const buyCount = Array.from(gridLevelManagers.values()).filter(l =>
        l.state === 'BUY_ACTIVE' || l.state === 'PLACING_BUY'
    ).length;
    const positionCount = Array.from(gridLevelManagers.values()).filter(l =>
        l.state === 'BOUGHT' || l.state === 'SELL_ACTIVE' || l.state === 'PLACING_SELL' || l.state === 'STUCK'
    ).length;

    addMessage(`💰 资金: 总${status.total} | 可用${status.available} | 买单${buyCount}个 | 持仓${positionCount}个 | 利润${status.profit}`, 'debug');
}

/**
 * 查询账户中指定币种的余额（使用Unified账户）
 */
async function getAccountBalance(coin) {
    try {
        if (!API_KEY || !API_SECRET) {
            addMessage('⚠️ 未配置API密钥，尝试使用Cookie方式...', 'warning');
            return null;
        }

        const result = await httpRequest_V5('/v5/account/wallet-balance', 'GET', {
            accountType: 'UNIFIED',
            coin: coin
        }, `查询${coin}余额`);

        if (result.success && result.data.result && result.data.result.list && result.data.result.list.length > 0) {
            const account = result.data.result.list[0];
            const coinData = account.coin.find(c => c.coin === coin);
            if (coinData) {
                const walletBalance = parseFloat(coinData.walletBalance);
                const availableBalance = parseFloat(coinData.availableToWithdraw || coinData.walletBalance);
                return {
                    total: walletBalance,
                    available: availableBalance,
                    locked: walletBalance - availableBalance
                };
            }
        }

        return null;
    } catch (error) {
        addMessage(`✗ 查询余额异常: ${error.message}`, 'error');
        return null;
    }
}

/**
 * 一键清仓 - 查询实际余额并卖出所有持仓（限价单）
 */
async function emergencySellAll() {
    if (!currentPrice || currentPrice <= 0) {
        addMessage('❌ 当前价格无效，无法执行清仓', 'error');
        return;
    }

    if (!instrumentInfo[gridConfig.symbol] || !instrumentInfo[gridConfig.symbol].baseCoin) {
        addMessage('❌ 交易对信息不完整，无法执行清仓', 'error');
        return;
    }

    addMessage('🚨 开始一键清仓...', 'warning');

    // ✅ 第一步：撤销所有现有订单（释放锁定的币）
    if (gridOrders.size > 0) {
        addMessage(`📋 检测到 ${gridOrders.size} 个挂单，先撤销以释放锁定资产...`, 'warning');
        await cancelAllGridOrders('清仓前撤单');
        // 等待撤单完成
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    addMessage('📡 正在查询账户实际余额...', 'info');

    const baseCoin = instrumentInfo[gridConfig.symbol].baseCoin;

    // ✅ 第二步：查询账户实际持仓（带重试机制）
    let balance = null;
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
        balance = await getAccountBalance(baseCoin);

        if (!balance || balance.total <= 0) {
            addMessage(`✓ 账户中没有 ${baseCoin} 持仓`, 'info');
            return;
        }

        // 如果有锁定的币，等待解锁
        if (balance.locked > 0 && retryCount < maxRetries - 1) {
            addMessage(`⏳ 检测到 ${balance.locked.toFixed(gridConfig.qtyPrecision)} ${baseCoin} 被锁定，等待解锁中... (${retryCount + 1}/${maxRetries})`, 'warning');
            await new Promise(resolve => setTimeout(resolve, 3000));
            retryCount++;
            continue;
        }

        break;
    }

    const totalQuantity = balance.total;
    const availableQuantity = balance.available;

    addMessage(`💼 账户余额: 总计 ${totalQuantity.toFixed(gridConfig.qtyPrecision)} ${baseCoin}`, 'info');
    addMessage(`💼 可卖数量: ${availableQuantity.toFixed(gridConfig.qtyPrecision)} ${baseCoin} (锁定: ${balance.locked.toFixed(gridConfig.qtyPrecision)})`, 'info');

    if (availableQuantity <= 0) {
        addMessage('❌ 没有可卖出的持仓（全部锁定在订单中或余额为0）', 'error');
        addMessage('💡 建议：手动前往交易所检查是否有未撤销的挂单', 'warning');
        return;
    }

    // 计算清仓前的估算盈亏（基于当前价格）
    const currentValue = availableQuantity * currentPrice;
    addMessage(`💰 当前市值: ${currentValue.toFixed(2)} USDT @ ${currentPrice}`, 'info');

    // ✅ 第二步：确认清仓
    if (!confirm(`确认要清空所有持仓吗？\n\n币种: ${baseCoin}\n数量: ${availableQuantity.toFixed(gridConfig.qtyPrecision)}\n当前价格: ${currentPrice}\n预估市值: ${currentValue.toFixed(2)} USDT\n\n将使用限价单（当前价-0.5%）快速卖出。`)) {
        addMessage('已取消清仓操作', 'info');
        return;
    }

    // ✅ 第三步：根据qtyStep调整数量
    let adjustedQuantity = availableQuantity;

    // 根据qtyStep向下取整，避免精度超限
    if (instrumentInfo[gridConfig.symbol]) {
        const qtyStep = instrumentInfo[gridConfig.symbol].qtyStep || 0.1;  // ✅ 直接读取qtyStep
        const minOrderQty = instrumentInfo[gridConfig.symbol].minOrderQty || 0.1;

        addMessage(`📐 交易规则: qtyStep=${qtyStep}, minOrderQty=${minOrderQty}`, 'info');

        if (qtyStep > 0) {
            // 向下取整到qtyStep的倍数
            adjustedQuantity = Math.floor(availableQuantity / qtyStep) * qtyStep;

            // ✅ 再次使用toFixed固定精度，避免浮点数精度问题
            // 计算qtyStep的小数位数
            const qtyStepStr = qtyStep.toString();
            const decimalPlaces = qtyStepStr.includes('.') ? qtyStepStr.split('.')[1].length : 0;
            adjustedQuantity = parseFloat(adjustedQuantity.toFixed(decimalPlaces));

            addMessage(`🔧 调整数量: ${availableQuantity} → ${adjustedQuantity} (qtyStep: ${qtyStep})`, 'info');
        }

        if (adjustedQuantity < minOrderQty) {
            addMessage(`❌ 调整后数量 ${adjustedQuantity} 小于最小下单量 ${minOrderQty}，无法清仓`, 'error');
            return;
        }
    } else {
        addMessage(`⚠️ 未找到交易对信息，使用默认qtyStep=0.1`, 'warning');

        // 使用默认精度调整
        const defaultQtyStep = 0.1;
        adjustedQuantity = Math.floor(availableQuantity / defaultQtyStep) * defaultQtyStep;
        adjustedQuantity = parseFloat(adjustedQuantity.toFixed(1));

        addMessage(`🔧 调整数量: ${availableQuantity} → ${adjustedQuantity} (默认qtyStep: ${defaultQtyStep})`, 'info');
    }

    // ✅ 检查订单金额是否满足最小要求
    const sellPrice = parseFloat((currentPrice * 0.995).toFixed(gridConfig.quotePrecision));
    const orderValue = adjustedQuantity * sellPrice;
    const minOrderValue = 5;  // Bybit现货最小订单金额通常是5 USDT

    if (orderValue < minOrderValue) {
        addMessage(`❌ 订单金额 ${orderValue.toFixed(2)} USDT 小于最小要求 ${minOrderValue} USDT，无法下单`, 'error');
        addMessage(`💡 建议：等待价格上涨或使用市价单`, 'warning');
        return;
    }

    addMessage(`🔄 开始卖出 ${adjustedQuantity} ${baseCoin}...`, 'info');
    addMessage(`💵 订单金额: ${orderValue.toFixed(2)} USDT (满足最小要求 ${minOrderValue} USDT)`, 'info');

    const clientOrderId = `EMERGENCY_SELL_ALL_${gridConfig.symbol}_${Date.now()}`;

    try {
        const result = await placeGridOrder_CookieBased(
            gridConfig.symbol,
            'Sell',
            sellPrice,
            adjustedQuantity,
            clientOrderId
        );

        if (result.success && result.data) {
            const orderId = result.data.orderId;

            addMessage(`✅ 清仓订单已提交: ${orderId.substring(0, 12)}...`, 'success');
            addMessage(`📋 数量: ${adjustedQuantity} ${baseCoin}`, 'success');
            addMessage(`📋 价格: ${sellPrice}`, 'success');
            addMessage(`📋 预估成交额: ${(adjustedQuantity * sellPrice).toFixed(2)} USDT`, 'success');

            // 如果有剩余数量（因为向下取整），提示用户
            const remainingQty = parseFloat((availableQuantity - adjustedQuantity).toFixed(8));
            if (remainingQty > 0.00000001) {
                addMessage(`⚠️ 剩余 ${remainingQty} ${baseCoin} 因精度限制未卖出（数量太小）`, 'warning');
            }

            // 保存订单信息（不关联任何网格）
            gridOrders.set(orderId, {
                levelIndex: -1,  // 标记为非网格订单
                side: 'Sell',
                price: sellPrice,
                quantity: adjustedQuantity,
                clientOrderId: clientOrderId,
                costBasis: 0,
                symbol: gridConfig.symbol,
                status: 'New',
                isEmergencySell: true  // 标记为清仓订单
            });

            // ✅ 不修改网格状态，因为这是独立的清仓订单
            // 清仓订单成交后，网格会自动重置（如果用户重新启动）

            renderGridPreviewTable();
            updateUnrealizedPnLDisplay();

            addMessage(`💡 提示: 清仓订单已下，请在交易所查看订单状态`, 'info');

            // ✅ 自动停止网格交易，避免清仓后继续买入
            if (isGridRunning) {
                addMessage(`🛑 自动停止网格交易（清仓后）`, 'warning');
                await stopGridTrading(false);  // 不取消清仓订单
            }
        } else {
            addMessage(`❌ 清仓失败: ${result.error || '未知错误'}`, 'error');

            // ✅ 详细诊断信息
            if (result.error && result.error.includes('Insufficient')) {
                addMessage(`📊 诊断信息:`, 'warning');
                addMessage(`   - 尝试卖出: ${adjustedQuantity} ${baseCoin}`, 'info');
                addMessage(`   - 账户显示可用: ${availableQuantity} ${baseCoin}`, 'info');
                addMessage(`   - 订单价格: ${sellPrice} USDT`, 'info');
                addMessage(`   - 订单金额: ${orderValue.toFixed(2)} USDT`, 'info');
                addMessage(`💡 可能原因:`, 'warning');
                addMessage(`   1. 币仍被锁定在未撤销的挂单中`, 'info');
                addMessage(`   2. API查询结果与实际不同步`, 'info');
                addMessage(`   3. 精度问题导致数量不符合规则`, 'info');
                addMessage(`🔧 建议操作:`, 'warning');
                addMessage(`   1. 前往 Bybit 交易所手动检查挂单`, 'info');
                addMessage(`   2. 手动撤销所有挂单后重试`, 'info');
                addMessage(`   3. 使用交易所的"一键平仓"功能`, 'info');
            }
        }

    } catch (error) {
        addMessage(`❌ 清仓异常: ${error.message}`, 'error');
    }
}

/**
 * 轮询订单状态（备用方案） + 订单一致性检查
 */
async function pollOrderStatus() {
    if (!isGridRunning || gridOrders.size === 0) return;

    const result = await httpRequest_V5('/v5/order/realtime', 'GET', {
        category: 'spot',
        symbol: gridConfig.symbol,
        openOnly: 0,
        limit: 50
    }, '轮询订单状态');

    if (result.success && result.data.result && result.data.result.list) {
        const apiOrders = result.data.result.list;

        // ✅ 一致性检查：比较本地订单数和API订单数
        const apiOrderIds = new Set(apiOrders.map(o => o.orderId));
        const localOrderIds = new Set(gridOrders.keys());

        // 找出本地存在但API不存在的订单（可能已成交或取消）
        const missingInApi = Array.from(localOrderIds).filter(id => !apiOrderIds.has(id));

        if (missingInApi.length > 0) {
            addMessage(`⚠️ 检测到 ${missingInApi.length} 个订单不在API返回中，开始排查`, 'warning');

            // 对每个缺失订单进行单独查询
            for (const orderId of missingInApi) {
                await checkMissingOrder(orderId);
            }
        }

        // 处理API返回的订单状态更新
        for (const apiOrder of apiOrders) {
            if (gridOrders.has(apiOrder.orderId)) {
                const localOrder = gridOrders.get(apiOrder.orderId);

                if (apiOrder.orderStatus === 'Filled' && localOrder.status !== 'Filled') {
                    addMessage(`💼 轮询检测到订单成交: ${apiOrder.orderId.substring(0, 12)}...`, 'info');
                    localOrder.status = 'Filled';
                    await handleOrderFilled(apiOrder.orderId, localOrder, parseFloat(apiOrder.cumExecQty));
                } else if (['Cancelled', 'Rejected'].includes(apiOrder.orderStatus) && localOrder.status !== apiOrder.orderStatus) {
                    addMessage(`⚠️ 订单已${apiOrder.orderStatus}: ${apiOrder.orderId.substring(0, 12)}...`, 'warning');
                    handleOrderCancelled(apiOrder.orderId, localOrder);
                }
            }
        }
    }
}

/**
 * 检查缺失订单的真实状态
 */
async function checkMissingOrder(orderId) {
    const localOrder = gridOrders.get(orderId);
    if (!localOrder) return;

    // 查询历史订单
    const result = await httpRequest_V5('/v5/order/history', 'GET', {
        category: 'spot',
        symbol: gridConfig.symbol,
        orderId: orderId
    }, `查询订单${orderId.substring(0, 12)}`);

    if (result.success && result.data.result && result.data.result.list && result.data.result.list.length > 0) {
        const order = result.data.result.list[0];

        if (order.orderStatus === 'Filled' && localOrder.status !== 'Filled') {
            addMessage(`🔍 发现遗漏成交订单: ${orderId.substring(0, 12)}... (${localOrder.side})`, 'warning');
            localOrder.status = 'Filled';
            await handleOrderFilled(orderId, localOrder, parseFloat(order.cumExecQty));
        } else if (['Cancelled', 'Rejected'].includes(order.orderStatus)) {
            addMessage(`🔍 订单已${order.orderStatus}: ${orderId.substring(0, 12)}...`, 'info');
            handleOrderCancelled(orderId, localOrder);
        }
    } else {
        // API中找不到，可能是非常旧的订单，直接清理
        addMessage(`⚠️ 无法查询到订单 ${orderId.substring(0, 12)}，从本地清理`, 'warning');
        handleOrderCancelled(orderId, localOrder);
    }
}

/**
 * 处理订单取消/拒绝
 */
function handleOrderCancelled(orderId, localOrder) {
    const level = gridLevelManagers.get(localOrder.levelIndex);
    if (!level) {
        gridOrders.delete(orderId);
        return;
    }

    if (localOrder.side === 'Buy') {
        if (level.lockedAmount > 0) {
            fundManager.unlockFromBuy(level.lockedAmount);
        }
        level.buyOrderFailed();
        activeBuyOrdersPerLevel.delete(localOrder.price.toFixed(gridConfig.quotePrecision));
    } else if (localOrder.side === 'Sell') {
        level.sellOrderFailed();
        activeSellOrdersPerLevel.delete(localOrder.price.toFixed(gridConfig.quotePrecision));
    }

    gridOrders.delete(orderId);
    renderGridPreviewTable();
}
/**
 * 处理订单完全成交
 */
async function handleOrderFilled(orderId, orderInfo, filledQty = null) {
    // ✅ 特殊处理：清仓订单（levelIndex = -1）
    if (orderInfo.levelIndex === -1 && orderInfo.isEmergencySell) {
        addMessage(`✅ 清仓订单已成交: ${orderId.substring(0, 12)}... 数量: ${orderInfo.quantity}`, 'success');

        // 记录卖出统计（不计算利润，因为没有买入成本）
        if (tradingStats && orderInfo.side === 'Sell') {
            // 不调用recordSell，因为没有对应的买入
            tradingStats.totalSellVolume += orderInfo.price * orderInfo.quantity;
            tradingStats.sellCount++;
        }

        gridOrders.delete(orderId);
        updateUnrealizedPnLDisplay();
        return;
    }

    const level = gridLevelManagers.get(orderInfo.levelIndex);
    if (!level) {
        addMessage(`❌ 错误: 无法找到网格 L${orderInfo.levelIndex + 1}`, 'error');
        gridOrders.delete(orderId);  // ✅ 删除无效订单
        return;
    }

    const actualQty = filledQty || orderInfo.quantity;

    if (orderInfo.side === 'Buy') {
        // 买单成交
        const buyPriceStr = orderInfo.price.toFixed(gridConfig.quotePrecision);
        activeBuyOrdersPerLevel.delete(buyPriceStr);

        fundManager.buyOrderFilled(level.lockedAmount);
        level.buyOrderFilled(actualQty);  // ✅ 传递实际成交数量

        // ✅ 记录买入统计
        if (tradingStats) {
            tradingStats.recordBuy(orderInfo.price, actualQty);
        }

        addMessage(`💰 买单成交! L${level.index + 1} @ ${orderInfo.price} x ${actualQty}`, 'success');

        gridOrders.delete(orderId);
        renderGridPreviewTable();
        updateUnrealizedPnLDisplay();  // ✅ 更新浮盈浮亏

        // ✅ 买单成交后，不立即下卖单，让定时检查统一处理
        // 原因：买单成交后币需要时间到账，立即下单会失败
        // 交给 performGridCheck() 在合适时机处理
        renderGridPreviewTable();

    } else if (orderInfo.side === 'Sell') {
        // 卖单成交
        const sellPriceStr = orderInfo.price.toFixed(gridConfig.quotePrecision);
        activeSellOrdersPerLevel.delete(sellPriceStr);

        // ✅ 使用实际成交数量计算
        const sellAmount = level.sellPrice * level.actualQuantity;
        const profit = fundManager.sellOrderFilled(level.costBasis, sellAmount);

        // ✅ 记录卖出统计（传入买入价格和卖出价格）
        if (tradingStats) {
            tradingStats.recordSell(orderInfo.price, actualQty, level.buyPrice);
        }

        level.sellOrderFilled();

        const profitPercent = (profit / level.costBasis * 100).toFixed(2);
        addMessage(`🎉 卖单成交! L${level.index + 1} @ ${orderInfo.price} x ${actualQty} | 利润: ${profit.toFixed(4)} USDT (${profitPercent}%)`, 'success');

        gridOrders.delete(orderId);
        logFundStatus();
        renderGridPreviewTable();
        updateUnrealizedPnLDisplay();  // ✅ 更新浮盈浮亏
    }
}

// ==================== 速刷模式核心逻辑 ====================

/**
 * 启动速刷模式
 */
async function startBrushMode() {
    if (isBrushRunning) {
        addMessage('速刷模式已在运行中', 'warning');
        return;
    }

    // ✅ 互斥检查：禁止与网格交易同时运行
    if (isGridRunning) {
        addMessage('❌ 网格交易正在运行，请先停止网格交易', 'error');
        return;
    }

    if (!currentPrice) {
        addMessage('等待价格数据...', 'warning');
        return;
    }

    // 读取配置
    brushConfig.symbol = brushSymbolInput ? brushSymbolInput.value.trim().toUpperCase() : 'NXPCUSDT';
    brushConfig.interval = brushIntervalInput ? parseInt(brushIntervalInput.value) : 10;
    brushConfig.capitalPercent = brushCapitalPercentInput ? parseFloat(brushCapitalPercentInput.value) : 100;
    brushConfig.priceOffset = brushPriceOffsetInput ? parseFloat(brushPriceOffsetInput.value) : 0.1;
    brushConfig.makerMode = brushMakerModeCheckbox ? brushMakerModeCheckbox.checked : true;
    brushConfig.orderTimeout = brushOrderTimeoutInput ? parseInt(brushOrderTimeoutInput.value) : 120;
    brushConfig.adaptiveMode = brushAdaptiveModeCheckbox ? brushAdaptiveModeCheckbox.checked : true;
    brushConfig.maxLoss = brushMaxLossInput ? parseFloat(brushMaxLossInput.value) : 50;
    brushConfig.maxVolume = brushMaxVolumeInput ? parseFloat(brushMaxVolumeInput.value) : 100000;
    brushConfig.stopOnError = brushStopOnErrorCheckbox ? brushStopOnErrorCheckbox.checked : true;

    // ✅ 智能配置建议
    if (brushConfig.makerMode) {
        if (brushConfig.priceOffset < 0.08) {
            addMessage(`⚠️ Maker模式价格偏移过小(${brushConfig.priceOffset}%)，成交率可能较低`, 'warning');
            addMessage(`💡 建议: 偏移0.1-0.2% 在成交率和收益间取得平衡`, 'info');
        }
        if (brushConfig.orderTimeout < 90) {
            addMessage(`⚠️ Maker模式订单超时过短(${brushConfig.orderTimeout}秒)，建议120秒以上`, 'warning');
        }
        if (!brushConfig.adaptiveMode) {
            addMessage(`💡 建议开启"自适应价格调整"，可大幅提高Maker成交率`, 'info');
        }
    } else {
        // Taker模式建议
        if (brushConfig.priceOffset > 0.2) {
            addMessage(`⚠️ Taker模式价格偏移过大(${brushConfig.priceOffset}%)，会造成较大亏损`, 'warning');
            addMessage(`💡 建议: 降低偏移到0.05-0.1%，成本可降低80%以上`, 'info');
        }
    }

    // ✅ 获取交易对信息（必须，用于精度控制）
    if (!instrumentInfo[brushConfig.symbol]) {
        addMessage(`📡 正在获取 ${brushConfig.symbol} 交易对信息...`, 'info');
        await getInstrumentInfo(brushConfig.symbol);
    }

    // 检查API配置
    const apiKeyToUse = API_KEY || (apiKeyInput ? apiKeyInput.value.trim() : '');
    const apiSecretToUse = API_SECRET || (apiSecretInput ? apiSecretInput.value.trim() : '');

    if (!apiKeyToUse || !apiSecretToUse) {
        addMessage('⚠️ 未配置API Key，速刷模式需要查询余额', 'warning');
        addMessage('💡 请在"参数设置"中配置API密钥', 'info');
        return;
    }

    // 重置统计
    brushStats = {
        startTime: Date.now(),
        brushCount: 0,
        totalVolume: 0,
        totalFees: 0,
        netLoss: 0,
        consecutiveErrors: 0,
        runtimeUpdateInterval: null
    };

    isBrushRunning = true;
    updateBrushUIState();

    // 启动运行时间更新定时器
    brushStats.runtimeUpdateInterval = setInterval(() => updateBrushRuntimeDisplay(), 1000);

    addMessage('🚀 速刷模式已启动!', 'success');
    addMessage(`交易对: ${brushConfig.symbol}`, 'info');
    addMessage(`刷单间隔: ${brushConfig.interval}秒`, 'info');
    addMessage(`使用资金: ${brushConfig.capitalPercent}%`, 'info');
    addMessage(`价格偏移: ±${brushConfig.priceOffset}%`, 'info');

    // ✅ 显示模式和预估成本
    const feeRate = brushConfig.makerMode ? parseFloat(currentFeeRate.makerFeeRate) : parseFloat(currentFeeRate.takerFeeRate);
    const priceSlippage = brushConfig.makerMode ? -brushConfig.priceOffset * 2 : brushConfig.priceOffset * 2;  // Maker赚价差，Taker亏价差
    const totalCostPercent = (feeRate * 2 * 100) + priceSlippage;  // 手续费 + 价差

    if (brushConfig.makerMode) {
        addMessage(`🔵 Maker模式: 挂单成交 | 费率${(feeRate * 100).toFixed(3)}% | 超时${brushConfig.orderTimeout}秒`, 'info');
        addMessage(`💰 预估成本: 手续费${(feeRate * 2 * 100).toFixed(3)}% - 价差${(brushConfig.priceOffset * 2).toFixed(2)}% = ${totalCostPercent >= 0 ? '亏损' : '盈利'} ${Math.abs(totalCostPercent).toFixed(3)}%/轮`, totalCostPercent >= 0 ? 'warning' : 'success');
    } else {
        addMessage(`🔴 Taker模式: 市价成交 | 费率${(feeRate * 100).toFixed(3)}%`, 'info');
        addMessage(`💰 预估成本: 手续费${(feeRate * 2 * 100).toFixed(3)}% + 价差${(brushConfig.priceOffset * 2).toFixed(2)}% = 亏损 ${totalCostPercent.toFixed(3)}%/轮`, totalCostPercent > 1 ? 'error' : 'warning');
    }

    addMessage(`安全上限: 最大亏损${brushConfig.maxLoss} USDT, 最大交易量${brushConfig.maxVolume} USDT`, 'warning');

    // 立即执行第一次刷单
    await performBrushCycle();
}

/**
 * 停止速刷模式
 */
function stopBrushMode() {
    if (!isBrushRunning) {
        addMessage('速刷模式未在运行', 'info');
        return;
    }

    isBrushRunning = false;

    // 停止定时器
    if (brushInterval) {
        clearTimeout(brushInterval);
        brushInterval = null;
    }

    if (brushStats.runtimeUpdateInterval) {
        clearInterval(brushStats.runtimeUpdateInterval);
        brushStats.runtimeUpdateInterval = null;
    }

    updateBrushUIState();

    // 输出最终统计
    const runtime = formatBrushRuntime();
    addMessage('⏹ 速刷模式已停止', 'success');
    addMessage(`📊 === 速刷统计报告 ===`, 'info');
    addMessage(`   运行时间: ${runtime}`, 'info');
    addMessage(`   刷单次数: ${brushStats.brushCount}次`, 'info');
    addMessage(`   总交易量: ${brushStats.totalVolume.toFixed(2)} USDT`, 'info');
    addMessage(`   总手续费: ${brushStats.totalFees.toFixed(4)} USDT`, 'info');
    addMessage(`   净亏损: ${brushStats.netLoss.toFixed(4)} USDT`, brushStats.netLoss > 0 ? 'error' : 'success');
}

/**
 * 执行一次完整的刷单循环（买入 -> 卖出）
 */
async function performBrushCycle() {
    if (!isBrushRunning) return;

    try {
        addMessage(`🔄 开始第 ${brushStats.brushCount + 1} 轮刷单...`, 'info');

        // 1. 查询账户USDT余额
        const usdtBalance = await getAccountBalance('USDT');
        if (!usdtBalance || usdtBalance.available <= 0) {
            addMessage('❌ 查询USDT余额失败或余额为0', 'error');
            brushStats.consecutiveErrors++;
            checkBrushSafety();
            scheduleNextBrushCycle();
            return;
        }

        const availableUsdt = usdtBalance.available;
        const useUsdt = availableUsdt * (brushConfig.capitalPercent / 100);

        addMessage(`💰 可用余额: ${availableUsdt.toFixed(2)} USDT, 本次使用: ${useUsdt.toFixed(2)} USDT`, 'debug');

        // 2. 计算买入价格和数量
        // ✅ Maker模式: 挂单低于市价买入，高于市价卖出 (赚取价差+低费率)
        // ✅ Taker模式: 市价单快速成交 (支付价差+高费率)
        let buyPrice;
        if (brushConfig.makerMode) {
            // Maker: 买入价 = 当前价 × (1 - 偏移%)  → 低于市价挂单
            buyPrice = parseFloat((currentPrice * (1 - brushConfig.priceOffset / 100)).toFixed(gridConfig.quotePrecision));
            addMessage(`🔵 Maker模式: 挂单买入 @ ${buyPrice} (低于市价 ${brushConfig.priceOffset}%)`, 'info');
        } else {
            // Taker: 买入价 = 当前价 × (1 + 偏移%)  → 高于市价快速成交
            buyPrice = parseFloat((currentPrice * (1 + brushConfig.priceOffset / 100)).toFixed(gridConfig.quotePrecision));
            addMessage(`🔴 Taker模式: 快速买入 @ ${buyPrice} (高于市价 ${brushConfig.priceOffset}%)`, 'debug');
        }
        let buyQuantity = useUsdt / buyPrice;

        // ✅ 根据qtyStep调整买入数量精度
        if (instrumentInfo[brushConfig.symbol]) {
            const qtyStep = instrumentInfo[brushConfig.symbol].qtyStep || 0.1;
            const minOrderQty = instrumentInfo[brushConfig.symbol].minOrderQty || 0.1;
            const adjustedQty = Math.floor(buyQuantity / qtyStep) * qtyStep;

            // 计算qtyStep的小数位数
            const qtyStepStr = qtyStep.toString();
            const decimalPlaces = qtyStepStr.includes('.') ? qtyStepStr.split('.')[1].length : 0;
            buyQuantity = parseFloat(adjustedQty.toFixed(decimalPlaces));

            // 检查是否低于最小下单量
            if (buyQuantity < minOrderQty) {
                addMessage(`❌ 买入数量 ${buyQuantity} 低于最小下单量 ${minOrderQty}，跳过本轮`, 'error');
                brushStats.consecutiveErrors++;
                checkBrushSafety();
                scheduleNextBrushCycle();
                return;
            }
        } else {
            buyQuantity = parseFloat(buyQuantity.toFixed(gridConfig.qtyPrecision));
        }

        addMessage(`📥 准备买入: ${buyQuantity} @ ${buyPrice}`, 'info');

        // 3. 下买单
        const buyOrderId = `BRUSH_BUY_${brushConfig.symbol}_${Date.now()}`;
        const buyResult = await placeGridOrder_CookieBased(
            brushConfig.symbol,
            'Buy',
            buyPrice,
            buyQuantity,
            buyOrderId
        );

        if (!buyResult.success) {
            addMessage(`❌ 买单失败: ${buyResult.error}`, 'error');
            brushStats.consecutiveErrors++;
            checkBrushSafety();
            scheduleNextBrushCycle();
            return;
        }

        const buyOrderIdActual = buyResult.data.orderId;
        addMessage(`✓ 买单已提交: ${buyOrderIdActual.substring(0, 12)}...`, 'success');

        // 4. 等待买单成交（三档降级策略：Maker → Maker保守 → Taker兜底）
        const buyTimeout = brushConfig.orderTimeout * 1000;  // 转换为毫秒
        let buyFilled = await waitForOrderFilled(buyOrderIdActual, brushConfig.symbol, buyTimeout);

        // 第1档：Maker超时后降级
        if (!buyFilled && brushConfig.makerMode && brushConfig.adaptiveMode) {
            addMessage(`⏰ 买单超时(第1档)，启动自适应调整...`, 'warning');
            await cancelOrder_CookieBased(brushConfig.symbol, buyOrderIdActual);

            // 第2档：缩小价格偏移 50%
            const newOffset = brushConfig.priceOffset * 0.5;
            const newBuyPrice = parseFloat((currentPrice * (1 - newOffset / 100)).toFixed(gridConfig.quotePrecision));

            addMessage(`🔄 第2档尝试: ${buyPrice} → ${newBuyPrice} (偏移${newOffset.toFixed(2)}%)`, 'info');

            const retryBuyOrderId = `BRUSH_BUY_RETRY_${brushConfig.symbol}_${Date.now()}`;
            const retryResult = await placeGridOrder_CookieBased(
                brushConfig.symbol,
                'Buy',
                newBuyPrice,
                buyQuantity,
                retryBuyOrderId
            );

            if (retryResult.success) {
                const retryOrderId = retryResult.data.orderId;
                addMessage(`✓ 第2档买单已提交: ${retryOrderId.substring(0, 12)}...`, 'success');

                // 等待第二次（时间缩短一半）
                buyFilled = await waitForOrderFilled(retryOrderId, brushConfig.symbol, buyTimeout / 2);

                if (!buyFilled) {
                    // 第3档：Taker兜底（保证不卡单）
                    addMessage(`⏰ 第2档超时，使用Taker兜底保证成交`, 'warning');
                    await cancelOrder_CookieBased(brushConfig.symbol, retryOrderId);

                    // Taker模式：高于市价0.03%快速买入
                    const takerBuyPrice = parseFloat((currentPrice * (1 + 0.03 / 100)).toFixed(gridConfig.quotePrecision));
                    addMessage(`🚀 第3档(Taker): 快速买入 @ ${takerBuyPrice} (+0.03%)`, 'info');

                    const takerBuyOrderId = `BRUSH_BUY_TAKER_${brushConfig.symbol}_${Date.now()}`;
                    const takerResult = await placeGridOrder_CookieBased(
                        brushConfig.symbol,
                        'Buy',
                        takerBuyPrice,
                        buyQuantity,
                        takerBuyOrderId
                    );

                    if (takerResult.success) {
                        const takerOrderId = takerResult.data.orderId;
                        buyFilled = await waitForOrderFilled(takerOrderId, brushConfig.symbol, 10000); // 10秒快速成交

                        if (!buyFilled) {
                            addMessage(`❌ Taker模式仍失败，跳过本轮`, 'error');
                            await cancelOrder_CookieBased(brushConfig.symbol, takerOrderId);
                            brushStats.consecutiveErrors++;
                            checkBrushSafety();
                            scheduleNextBrushCycle();
                            return;
                        } else {
                            buyPrice = takerBuyPrice;
                            addMessage(`✅ Taker买入成交 (保证进度)`, 'success');
                        }
                    } else {
                        brushStats.consecutiveErrors++;
                        checkBrushSafety();
                        scheduleNextBrushCycle();
                        return;
                    }
                } else {
                    buyPrice = newBuyPrice;  // 更新实际成交价格
                }
            } else {
                brushStats.consecutiveErrors++;
                checkBrushSafety();
                scheduleNextBrushCycle();
                return;
            }
        } else if (!buyFilled) {
            // 非Maker模式或未启用自适应，直接失败
            addMessage(`❌ 买单超时未成交(${brushConfig.orderTimeout}秒)，尝试撤销...`, 'error');
            await cancelOrder_CookieBased(brushConfig.symbol, buyOrderIdActual);
            brushStats.consecutiveErrors++;
            checkBrushSafety();
            scheduleNextBrushCycle();
            return;
        }

        addMessage(`✅ 买单已成交!`, 'success');

        // 记录买入统计
        const buyVolume = buyPrice * buyQuantity;
        const buyFeeRate = brushConfig.makerMode ? parseFloat(currentFeeRate.makerFeeRate) : parseFloat(currentFeeRate.takerFeeRate);
        const buyFee = buyVolume * buyFeeRate;
        brushStats.totalVolume += buyVolume;
        brushStats.totalFees += buyFee;

        // 5. 等待币到账（10秒）
        addMessage(`⏳ 等待币到账...`, 'debug');
        await new Promise(resolve => setTimeout(resolve, 10000));

        // 6. 查询实际可卖数量
        const baseCoin = instrumentInfo[brushConfig.symbol].baseCoin;
        const coinBalance = await getAccountBalance(baseCoin);

        if (!coinBalance || coinBalance.available <= 0) {
            addMessage(`❌ 查询币余额失败或余额为0，等待下次循环`, 'error');
            brushStats.consecutiveErrors++;
            checkBrushSafety();
            scheduleNextBrushCycle();
            return;
        }

        let sellQuantity = coinBalance.available;

        // ✅ 根据qtyStep调整数量精度，避免精度超限
        if (instrumentInfo[brushConfig.symbol]) {
            const qtyStep = instrumentInfo[brushConfig.symbol].qtyStep || 0.1;
            const minOrderQty = instrumentInfo[brushConfig.symbol].minOrderQty || 0.1;
            const adjustedQty = Math.floor(sellQuantity / qtyStep) * qtyStep;

            // 计算qtyStep的小数位数
            const qtyStepStr = qtyStep.toString();
            const decimalPlaces = qtyStepStr.includes('.') ? qtyStepStr.split('.')[1].length : 0;
            sellQuantity = parseFloat(adjustedQty.toFixed(decimalPlaces));

            addMessage(`💼 可卖数量: ${coinBalance.available} → 调整为: ${sellQuantity} ${baseCoin} (qtyStep: ${qtyStep})`, 'debug');

            // 检查是否低于最小下单量
            if (sellQuantity < minOrderQty) {
                addMessage(`❌ 卖出数量 ${sellQuantity} 低于最小下单量 ${minOrderQty}，跳过本轮`, 'error');
                brushStats.consecutiveErrors++;
                checkBrushSafety();
                scheduleNextBrushCycle();
                return;
            }
        } else {
            addMessage(`💼 可卖数量: ${sellQuantity.toFixed(gridConfig.qtyPrecision)} ${baseCoin}`, 'debug');
        }

        // 7. 计算卖出价格
        let sellPrice;
        if (brushConfig.makerMode) {
            // Maker: 卖出价 = 当前价 × (1 + 偏移%)  → 高于市价挂单
            sellPrice = parseFloat((currentPrice * (1 + brushConfig.priceOffset / 100)).toFixed(gridConfig.quotePrecision));
            addMessage(`🔵 Maker模式: 挂单卖出 @ ${sellPrice} (高于市价 ${brushConfig.priceOffset}%)`, 'info');
        } else {
            // Taker: 卖出价 = 当前价 × (1 - 偏移%)  → 低于市价快速成交
            sellPrice = parseFloat((currentPrice * (1 - brushConfig.priceOffset / 100)).toFixed(gridConfig.quotePrecision));
            addMessage(`🔴 Taker模式: 快速卖出 @ ${sellPrice} (低于市价 ${brushConfig.priceOffset}%)`, 'debug');
        }

        addMessage(`📤 准备卖出: ${sellQuantity} @ ${sellPrice}`, 'info');

        // 8. 下卖单
        const sellOrderId = `BRUSH_SELL_${brushConfig.symbol}_${Date.now()}`;
        const sellResult = await placeGridOrder_CookieBased(
            brushConfig.symbol,
            'Sell',
            sellPrice,
            sellQuantity,
            sellOrderId
        );

        if (!sellResult.success) {
            addMessage(`❌ 卖单失败: ${sellResult.error}`, 'error');
            brushStats.consecutiveErrors++;
            checkBrushSafety();
            scheduleNextBrushCycle();
            return;
        }

        const sellOrderIdActual = sellResult.data.orderId;
        addMessage(`✓ 卖单已提交: ${sellOrderIdActual.substring(0, 12)}...`, 'success');

        // 9. 等待卖单成交（三档降级策略：Maker → Maker保守 → Taker兜底）
        const sellTimeout = brushConfig.orderTimeout * 1000;  // 转换为毫秒
        let sellFilled = await waitForOrderFilled(sellOrderIdActual, brushConfig.symbol, sellTimeout);

        // 第1档：Maker超时后降级
        if (!sellFilled && brushConfig.makerMode && brushConfig.adaptiveMode) {
            addMessage(`⏰ 卖单超时(第1档)，启动自适应调整...`, 'warning');
            await cancelOrder_CookieBased(brushConfig.symbol, sellOrderIdActual);

            // 第2档：缩小价格偏移 50%
            const newOffset = brushConfig.priceOffset * 0.5;
            const newSellPrice = parseFloat((currentPrice * (1 + newOffset / 100)).toFixed(gridConfig.quotePrecision));

            addMessage(`🔄 第2档尝试: ${sellPrice} → ${newSellPrice} (偏移${newOffset.toFixed(2)}%)`, 'info');

            // 重新下单
            const retrySellOrderId = `BRUSH_SELL_RETRY_${brushConfig.symbol}_${Date.now()}`;
            const retryResult = await placeGridOrder_CookieBased(
                brushConfig.symbol,
                'Sell',
                newSellPrice,
                sellQuantity,
                retrySellOrderId
            );

            if (retryResult.success) {
                const retryOrderId = retryResult.data.orderId;
                addMessage(`✓ 第2档卖单已提交: ${retryOrderId.substring(0, 12)}...`, 'success');

                // 等待第二次（时间缩短一半）
                sellFilled = await waitForOrderFilled(retryOrderId, brushConfig.symbol, sellTimeout / 2);

                if (!sellFilled) {
                    // 第3档：Taker兜底（保证不卡单）
                    addMessage(`⏰ 第2档超时，使用Taker兜底保证成交`, 'warning');
                    await cancelOrder_CookieBased(brushConfig.symbol, retryOrderId);

                    // Taker模式：低于市价0.03%快速卖出
                    const takerSellPrice = parseFloat((currentPrice * (1 - 0.03 / 100)).toFixed(gridConfig.quotePrecision));
                    addMessage(`🚀 第3档(Taker): 快速卖出 @ ${takerSellPrice} (-0.03%)`, 'info');

                    const takerSellOrderId = `BRUSH_SELL_TAKER_${brushConfig.symbol}_${Date.now()}`;
                    const takerResult = await placeGridOrder_CookieBased(
                        brushConfig.symbol,
                        'Sell',
                        takerSellPrice,
                        sellQuantity,
                        takerSellOrderId
                    );

                    if (takerResult.success) {
                        const takerOrderId = takerResult.data.orderId;
                        sellFilled = await waitForOrderFilled(takerOrderId, brushConfig.symbol, 10000); // 10秒快速成交

                        if (!sellFilled) {
                            addMessage(`❌ Taker模式仍失败，跳过本轮`, 'error');
                            await cancelOrder_CookieBased(brushConfig.symbol, takerOrderId);
                            brushStats.consecutiveErrors++;
                            checkBrushSafety();
                            scheduleNextBrushCycle();
                            return;
                        } else {
                            sellPrice = takerSellPrice;
                            addMessage(`✅ Taker卖出成交 (保证进度)`, 'success');
                        }
                    } else {
                        brushStats.consecutiveErrors++;
                        checkBrushSafety();
                        scheduleNextBrushCycle();
                        return;
                    }
                } else {
                    sellPrice = newSellPrice;  // 更新实际成交价格
                }
            } else {
                brushStats.consecutiveErrors++;
                checkBrushSafety();
                scheduleNextBrushCycle();
                return;
            }
        } else if (!sellFilled) {
            // 非Maker模式或未启用自适应，直接失败
            addMessage(`❌ 卖单超时未成交(${brushConfig.orderTimeout}秒)，尝试撤销...`, 'error');
            await cancelOrder_CookieBased(brushConfig.symbol, sellOrderIdActual);
            brushStats.consecutiveErrors++;
            checkBrushSafety();
            scheduleNextBrushCycle();
            return;
        }

        addMessage(`✅ 卖单已成交!`, 'success');

        // 记录卖出统计
        const sellVolume = sellPrice * sellQuantity;
        const sellFeeRate = brushConfig.makerMode ? parseFloat(currentFeeRate.makerFeeRate) : parseFloat(currentFeeRate.takerFeeRate);
        const sellFee = sellVolume * sellFeeRate;
        brushStats.totalVolume += sellVolume;
        brushStats.totalFees += sellFee;

        // 计算净盈亏
        // ✅ Maker模式: (卖出价 - 买入价) × 数量 - 手续费 = 正利润（理论上）
        // ✅ Taker模式: (卖出价 - 买入价) × 数量 - 手续费 = 负利润（亏损）
        const priceDiff = sellVolume - buyVolume;  // 价差盈亏
        const cycleLoss = buyFee + sellFee + (buyVolume - sellVolume);  // 总成本（兼容旧统计）
        const cycleProfit = priceDiff - buyFee - sellFee;  // 实际净盈亏
        brushStats.netLoss += cycleLoss;

        // 刷单次数+1
        brushStats.brushCount++;
        brushStats.consecutiveErrors = 0;  // 重置连续错误计数

        // ✅ 显示本轮盈亏详情
        const modeText = brushConfig.makerMode ? '🔵 Maker' : '🔴 Taker';
        const profitText = cycleProfit >= 0 ? `盈利 ${cycleProfit.toFixed(4)}` : `亏损 ${Math.abs(cycleProfit).toFixed(4)}`;
        addMessage(`🎉 第 ${brushStats.brushCount} 轮完成! ${modeText} | 本轮${profitText} USDT`, cycleProfit >= 0 ? 'success' : 'info');
        addMessage(`📊 明细: 价差${priceDiff.toFixed(4)} USDT, 手续费${(buyFee + sellFee).toFixed(4)} USDT (费率${(buyFeeRate * 100).toFixed(3)}%)`, 'debug');
        addMessage(`📊 累计: 交易量${brushStats.totalVolume.toFixed(2)} USDT, 手续费${brushStats.totalFees.toFixed(4)} USDT`, 'info');

        updateBrushStatsDisplay();

        // 检查安全限制
        if (!checkBrushSafety()) {
            return;  // 达到上限，停止刷单
        }

    } catch (error) {
        addMessage(`❌ 刷单异常: ${error.message}`, 'error');
        brushStats.consecutiveErrors++;
        checkBrushSafety();
    }

    // 安排下一次刷单
    scheduleNextBrushCycle();
}

/**
 * 等待订单成交
 */
async function waitForOrderFilled(orderId, symbol, timeout = 30000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        try {
            const result = await httpRequest_V5('/v5/order/realtime', 'GET', {
                category: 'spot',
                symbol: symbol,
                orderId: orderId
            }, `查询订单${orderId.substring(0, 12)}`);

            if (result.success && result.data.result && result.data.result.list && result.data.result.list.length > 0) {
                const order = result.data.result.list[0];
                if (order.orderStatus === 'Filled') {
                    return true;
                } else if (['Cancelled', 'Rejected'].includes(order.orderStatus)) {
                    return false;
                }
            }
        } catch (error) {
            addMessage(`查询订单状态异常: ${error.message}`, 'error');
        }

        await new Promise(resolve => setTimeout(resolve, 2000));  // 每2秒查询一次
    }

    return false;  // 超时
}

/**
 * 检查安全限制
 */
function checkBrushSafety() {
    // 检查最大亏损
    if (brushStats.netLoss >= brushConfig.maxLoss) {
        addMessage(`🛑 达到最大亏损限制 (${brushConfig.maxLoss} USDT)，自动停止`, 'error');
        stopBrushMode();
        return false;
    }

    // 检查最大交易量
    if (brushStats.totalVolume >= brushConfig.maxVolume) {
        addMessage(`🎯 达到目标交易量 (${brushConfig.maxVolume} USDT)，自动停止`, 'success');
        stopBrushMode();
        return false;
    }

    // 检查连续错误
    if (brushConfig.stopOnError && brushStats.consecutiveErrors >= 5) {
        addMessage(`🛑 连续失败 ${brushStats.consecutiveErrors} 次，自动停止`, 'error');
        stopBrushMode();
        return false;
    }

    return true;
}

/**
 * 安排下一次刷单
 */
function scheduleNextBrushCycle() {
    if (!isBrushRunning) return;

    addMessage(`⏰ ${brushConfig.interval}秒后开始下一轮...`, 'debug');
    brushInterval = setTimeout(() => performBrushCycle(), brushConfig.interval * 1000);
}

/**
 * 更新速刷模式UI状态
 */
function updateBrushUIState() {
    if (isBrushRunning) {
        if (brushStatusSpan) {
            brushStatusSpan.textContent = '运行中';
            brushStatusSpan.classList.remove('stopped');
            brushStatusSpan.classList.add('running');
        }
        if (startBrushBtn) startBrushBtn.disabled = true;
        if (stopBrushBtn) stopBrushBtn.disabled = false;

        // 禁用配置输入
        const inputs = [brushSymbolInput, brushIntervalInput, brushCapitalPercentInput,
                       brushPriceOffsetInput, brushMakerModeCheckbox, brushOrderTimeoutInput, brushAdaptiveModeCheckbox,
                       brushMaxLossInput, brushMaxVolumeInput, brushStopOnErrorCheckbox];
        inputs.forEach(input => { if (input) input.disabled = true; });
    } else {
        if (brushStatusSpan) {
            brushStatusSpan.textContent = '已停止';
            brushStatusSpan.classList.remove('running');
            brushStatusSpan.classList.add('stopped');
        }
        if (startBrushBtn) startBrushBtn.disabled = false;
        if (stopBrushBtn) stopBrushBtn.disabled = true;

        // 启用配置输入
        const inputs = [brushSymbolInput, brushIntervalInput, brushCapitalPercentInput,
                       brushPriceOffsetInput, brushMakerModeCheckbox, brushOrderTimeoutInput, brushAdaptiveModeCheckbox,
                       brushMaxLossInput, brushMaxVolumeInput, brushStopOnErrorCheckbox];
        inputs.forEach(input => { if (input) input.disabled = false; });
    }
}

/**
 * 更新速刷统计显示
 */
function updateBrushStatsDisplay() {
    if (brushCountSpan) brushCountSpan.textContent = brushStats.brushCount;
    if (brushVolumeSpan) brushVolumeSpan.textContent = brushStats.totalVolume.toFixed(2);
    if (brushFeesSpan) brushFeesSpan.textContent = brushStats.totalFees.toFixed(4);
    if (brushLossSpan) brushLossSpan.textContent = brushStats.netLoss.toFixed(4);
}

/**
 * 更新运行时间显示
 */
function updateBrushRuntimeDisplay() {
    if (brushRuntimeSpan && brushStats.startTime) {
        brushRuntimeSpan.textContent = formatBrushRuntime();
    }
}

/**
 * 格式化运行时间
 */
function formatBrushRuntime() {
    if (!brushStats.startTime) return '0秒';

    const ms = Date.now() - brushStats.startTime;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return `${days}天 ${hours % 24}时 ${minutes % 60}分 ${seconds % 60}秒`;
    } else if (hours > 0) {
        return `${hours}时 ${minutes % 60}分 ${seconds % 60}秒`;
    } else if (minutes > 0) {
        return `${minutes}分 ${seconds % 60}秒`;
    } else {
        return `${seconds}秒`;
    }
}

// ==================== WebSocket Functions ====================

function startWsHeartbeat(ws, intervalIdRef, type) { 
    if (intervalIdRef.id) clearInterval(intervalIdRef.id);
    intervalIdRef.id = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 'ping', req_id: `${type}_hb_${Date.now()}` }));
        } else { clearInterval(intervalIdRef.id); intervalIdRef.id = null; }
    }, 20000); 
}

function stopWsHeartbeat(intervalIdRef) { 
     if (intervalIdRef.id) { clearInterval(intervalIdRef.id); intervalIdRef.id = null; }
}

function initializePriceWebSocket() { 
    const symbolToSubscribe = (gridSymbolInput ? gridSymbolInput.value.trim().toUpperCase() : null) || gridConfig.symbol || 'BTCUSDT';
    if(currentSymbolSpan) currentSymbolSpan.textContent = symbolToSubscribe;
    
    if (priceWs && (priceWs.readyState === WebSocket.OPEN || priceWs.readyState === WebSocket.CONNECTING)) {
        if (priceWs.currentSymbol === symbolToSubscribe) return; 
        priceWs.close(1000, "Symbol changed"); 
    }
    
    priceWs = new WebSocket('wss://stream.bybit.com/v5/public/spot');
    priceWs.currentSymbol = symbolToSubscribe; 
    const intervalRef = { id: priceWsHeartbeatInterval };
    
    priceWs.onopen = () => {
        priceWs.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${symbolToSubscribe}`], req_id: `price_sub_${Date.now()}` }));
        startWsHeartbeat(priceWs, intervalRef, 'Price'); 
        priceWsHeartbeatInterval = intervalRef.id;
        addMessage(`✓ 价格WebSocket连接成功 (${symbolToSubscribe})`, 'success');
        reconnectAttempts = 0; 
    };
    
    priceWs.onmessage = async (event) => { 
        const data = JSON.parse(event.data);
        if (data.op === 'subscribe') {
            if (!data.success) {
                addMessage(`价格订阅失败: ${data.ret_msg}`, 'error');
            } else { 
                addMessage(`✓ 价格订阅成功`, 'success'); 
            }
        } else if (data.topic && data.topic.startsWith(`publicTrade.`)) {
            if (data.data && data.data.length > 0) {
                const trade = data.data[0]; 
                const newPrice = parseFloat(trade.p);
                if (newPrice !== currentPrice || currentPrice === null) {
                    currentPrice = newPrice;
                    if (currentPriceSpan) currentPriceSpan.textContent = currentPrice.toFixed(gridConfig.quotePrecision);
                    if (lastUpdatedSpan) lastUpdatedSpan.textContent = new Date(trade.T).toLocaleTimeString();
                    // ✅ 价格更新时刷新浮盈浮亏
                    updateUnrealizedPnLDisplay();
                }
            }
        }
    };
    
    priceWs.onclose = (event) => {
        stopWsHeartbeat({ id: priceWsHeartbeatInterval }); 
        priceWsHeartbeatInterval = null;
        addMessage(`价格WebSocket断开 (Code: ${event.code})`, event.code === 1000 ? 'info' : 'error');
        if (event.code !== 1000) { 
            reconnectAttempts++; 
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts -1), maxReconnectDelay);
            addMessage(`${reconnectAttempts} 次尝试重连于 ${delay / 1000}s 后...`, 'info');
            setTimeout(initializePriceWebSocket, delay);
        }
    };
    
    priceWs.onerror = (err) => { 
        console.error("Price WS Error:", err); 
        addMessage(`价格WebSocket错误`, 'error'); 
    };
}

async function initializeOrderWebSocket() { 
    const currentApiKey = API_KEY || (apiKeyInput ? apiKeyInput.value.trim() : '');
    const currentApiSecret = API_SECRET || (apiSecretInput ? apiSecretInput.value.trim() : '');
    if (!currentApiKey || !currentApiSecret) { 
        addMessage('无法监听订单，缺少API密钥', 'error'); 
        return; 
    }
    
    if (orderWs && (orderWs.readyState === WebSocket.OPEN || orderWs.readyState === WebSocket.CONNECTING)) return;
    
    await syncServerTime(); 
    const expires = getAdjustedTimestamp() + 20000; 
    const signature = await getWebSocketAuthSignature(currentApiSecret, expires.toString());
    
    orderWs = new WebSocket('wss://stream.bybit.com/v5/private');
    const intervalRef = { id: orderWsHeartbeatInterval };
    
    orderWs.onopen = () => {
        addMessage('✓ 订单WebSocket连接成功，正在认证...', 'success');
        orderWs.send(JSON.stringify({ op: 'auth', args: [currentApiKey, expires.toString(), signature], req_id: `order_auth_${Date.now()}` }));
    };
    
    orderWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.op === 'auth') {
            if (data.success) {
                addMessage('✓ 订单WebSocket认证成功', 'success');
                orderWs.send(JSON.stringify({ op: 'subscribe', args: ['order'], req_id: `order_sub_${Date.now()}` }));
                startWsHeartbeat(orderWs, intervalRef, 'Order'); 
                orderWsHeartbeatInterval = intervalRef.id;
            } else { 
                addMessage(`订单WebSocket认证失败: ${data.ret_msg}`, 'error'); 
                orderWs.close(1000, "Auth failed"); 
            }
        } else if (data.op === 'subscribe') {
            if (data.success) { 
                addMessage(`✓ 订单主题订阅成功`, 'success'); 
            } else { 
                addMessage(`订单主题订阅失败: ${data.ret_msg}`, 'error'); 
            }
        } else if (data.topic === 'order' && data.data) {
            data.data.forEach(async orderUpdate => {
                if (gridOrders.has(orderUpdate.orderId)) {
                    const localOrder = gridOrders.get(orderUpdate.orderId);

                    if (orderUpdate.orderStatus === 'Filled') {
                        await handleOrderFilled(orderUpdate.orderId, localOrder, parseFloat(orderUpdate.cumExecQty));
                    } else if (['Cancelled', 'Rejected', 'Deactivated'].includes(orderUpdate.orderStatus)) {
                        addMessage(`订单 ${orderUpdate.orderId.substring(0, 12)}... 状态: ${orderUpdate.orderStatus}`, 'warning');

                        const level = gridLevelManagers.get(localOrder.levelIndex);
                        if (level) {
                            if (localOrder.side === 'Buy') {
                                fundManager.unlockFromBuy(level.lockedAmount);
                                level.buyOrderFailed();
                                activeBuyOrdersPerLevel.delete(localOrder.price.toFixed(gridConfig.quotePrecision));
                            } else {
                                level.sellOrderFailed();
                                activeSellOrdersPerLevel.delete(localOrder.price.toFixed(gridConfig.quotePrecision));
                            }
                        }

                        gridOrders.delete(orderUpdate.orderId);
                        renderGridPreviewTable();
                    } else {
                        localOrder.status = orderUpdate.orderStatus;
                        gridOrders.set(orderUpdate.orderId, localOrder);
                    }
                }
            });
        }
    };
    
    orderWs.onclose = (event) => {
        stopWsHeartbeat({ id: orderWsHeartbeatInterval }); 
        orderWsHeartbeatInterval = null;
        addMessage(`订单WebSocket断开 (Code: ${event.code})`, event.code === 1000 ? 'info' : 'error');
        
        if (isGridRunning && event.code !== 1000) { 
            reconnectAttempts++; 
            const delay = Math.min(5000 * Math.pow(2, reconnectAttempts -1), maxReconnectDelay);
            addMessage(`订单WebSocket尝试重连于 ${delay / 1000}s 后...`, 'info');
            setTimeout(initializeOrderWebSocket, delay);
        }
    };
    
    orderWs.onerror = (err) => { 
        console.error("Order WS Error:", err); 
        addMessage('订单WebSocket错误', 'error'); 
    };
}

function closeOrderWebSocket() { 
    if (orderWs) {
        stopWsHeartbeat({ id: orderWsHeartbeatInterval }); 
        orderWsHeartbeatInterval = null;
        if (orderWs.readyState === WebSocket.OPEN || orderWs.readyState === WebSocket.CONNECTING) { 
            orderWs.close(1000, "User initiated close"); 
        }
        orderWs = null; 
        addMessage('订单WebSocket已关闭', 'info');
    }
}

// ==================== UI Functions ====================

function addMessage(text, type = 'info') { 
    if (!messages) messages = []; 
    messages.unshift({ text, type, timestamp: Date.now() });
    if (messages.length > 150) messages.pop(); 
    renderMessages(); 
}

function renderMessages() { 
    if (!messageList) return;
    messageList.innerHTML = messages.map(msg => 
        `<li class="${msg.type === 'debug' ? 'info' : msg.type}">[${new Date(msg.timestamp).toLocaleTimeString()}] ${msg.text}</li>`
    ).join('');
}

function updateGridUIState() {
    const commonInputs = [
        gridSymbolInput, profitPercentInput,
        gridCountInput, capitalPercentInput, rebalanceThresholdInput,
        checkIntervalInput, autoRebalanceCheckbox
    ];
    
    if (isGridRunning) {
        if(gridStatusSpan) { 
            gridStatusSpan.textContent = '运行中'; 
            gridStatusSpan.classList.remove('stopped'); 
            gridStatusSpan.classList.add('running'); 
        }
        if(startGridBtn) startGridBtn.disabled = true; 
        if(stopGridBtn) stopGridBtn.disabled = false; 
        if(calculateGridBtn) calculateGridBtn.disabled = true;
        if(forceRebalanceBtn) forceRebalanceBtn.disabled = false;
        commonInputs.forEach(input => { if(input) input.disabled = true; });
    } else {
        if(gridStatusSpan) { 
            gridStatusSpan.textContent = '已停止'; 
            gridStatusSpan.classList.remove('running'); 
            gridStatusSpan.classList.add('stopped'); 
        }
        if(startGridBtn) startGridBtn.disabled = false; 
        if(stopGridBtn) stopGridBtn.disabled = true; 
        if(calculateGridBtn) calculateGridBtn.disabled = false;
        if(forceRebalanceBtn) forceRebalanceBtn.disabled = true;
        commonInputs.forEach(input => { if(input) input.disabled = false; });
    }
}

function switchTab(targetTabId, targetBtn) { 
    document.querySelectorAll('.tab-content.active').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-nav > div.active').forEach(btn => btn.classList.remove('active'));
    const tabToShow = document.getElementById(targetTabId);
    if (tabToShow) tabToShow.classList.add('active'); 
    if (targetBtn) targetBtn.classList.add('active');
}

// ==================== Initialization ====================

function getElementByIdSafe(id, isCritical = true) { 
    const element = document.getElementById(id);
    if (!element && isCritical) {
        console.error(`DOM元素 ID '${id}' 未找到!`);
    }
    return element;
}

function initDOMElements() { 
    messageList = getElementByIdSafe('message-list', true);
    
    gridSymbolInput = getElementByIdSafe('grid-symbol');
    profitPercentInput = getElementByIdSafe('profit-percent');
    gridCountInput = getElementByIdSafe('grid-count');
    capitalPercentInput = getElementByIdSafe('capital-percent');
    rebalanceThresholdInput = getElementByIdSafe('rebalance-threshold');
    checkIntervalInput = getElementByIdSafe('check-interval');
    autoRebalanceCheckbox = getElementByIdSafe('auto-rebalance-enabled');
    
    usdtPerGridSpan = getElementByIdSafe('usdt-per-grid', false);
    priceIntervalSpan = getElementByIdSafe('price-interval', false); 
    currentUpperPriceSpan = getElementByIdSafe('current-upper-price', false);
    currentLowerPriceSpan = getElementByIdSafe('current-lower-price', false);
    gridCenterPriceSpan = getElementByIdSafe('grid-center-price', false);
    rebalanceCountSpan = getElementByIdSafe('rebalance-count', false);
    gridPreviewTableBody = getElementByIdSafe('grid-preview-table-body'); 
    
    startGridBtn = getElementByIdSafe('start-grid-btn');
    stopGridBtn = getElementByIdSafe('stop-grid-btn'); 
    calculateGridBtn = getElementByIdSafe('calculate-grid-btn'); 
    forceRebalanceBtn = getElementByIdSafe('force-rebalance-btn');
    gridStatusSpan = getElementByIdSafe('grid-status');
    
    currentPriceSpan = getElementByIdSafe('current-price'); 
    lastUpdatedSpan = getElementByIdSafe('last-updated'); 
    feeRateSpan = getElementByIdSafe('fee-rate');
    currentSymbolSpan = getElementByIdSafe('current-symbol'); 
    
    apiKeyInput = getElementByIdSafe('api-key');
    apiSecretInput = getElementByIdSafe('api-secret');
    passwordInput = getElementByIdSafe('password');

    // 统计显示元素
    runtimeSpan = getElementByIdSafe('runtime', false);
    totalVolumeSpan = getElementByIdSafe('total-volume', false);
    buyVolumeSpan = getElementByIdSafe('buy-volume', false);
    sellVolumeSpan = getElementByIdSafe('sell-volume', false);
    feesCostSpan = getElementByIdSafe('fees-cost', false);
    buyCountSpan = getElementByIdSafe('buy-count', false);
    sellCountSpan = getElementByIdSafe('sell-count', false);
    netProfitSpan = getElementByIdSafe('net-profit', false);

    // ✅ 浮盈浮亏显示元素
    window.positionCountSpan = getElementByIdSafe('position-count', false);
    window.totalQuantitySpan = getElementByIdSafe('total-quantity', false);
    window.positionCostSpan = getElementByIdSafe('position-cost', false);
    window.positionValueSpan = getElementByIdSafe('position-value', false);
    window.unrealizedPnlSpan = getElementByIdSafe('unrealized-pnl', false);
    window.unrealizedPnlPercentSpan = getElementByIdSafe('unrealized-pnl-percent', false);

    // 🛡️ 止损UI元素
    gridStoplossEnabledCheckbox = getElementByIdSafe('grid-stoploss-enabled', false);
    gridStoplossPercentInput = getElementByIdSafe('grid-stoploss-percent', false);
    totalStoplossEnabledCheckbox = getElementByIdSafe('total-stoploss-enabled', false);
    totalStoplossUsdtInput = getElementByIdSafe('total-stoploss-usdt', false);
    stoplossTriggerCountSpan = getElementByIdSafe('stoploss-trigger-count', false);
    totalStoplossStatusSpan = getElementByIdSafe('total-stoploss-status', false);

    // 🚀 速刷模式UI元素
    brushSymbolInput = getElementByIdSafe('brush-symbol', false);
    brushIntervalInput = getElementByIdSafe('brush-interval', false);
    brushCapitalPercentInput = getElementByIdSafe('brush-capital-percent', false);
    brushPriceOffsetInput = getElementByIdSafe('brush-price-offset', false);
    brushMakerModeCheckbox = getElementByIdSafe('brush-maker-mode', false);
    brushOrderTimeoutInput = getElementByIdSafe('brush-order-timeout', false);
    brushAdaptiveModeCheckbox = getElementByIdSafe('brush-adaptive-mode', false);
    brushMaxLossInput = getElementByIdSafe('brush-max-loss', false);
    brushMaxVolumeInput = getElementByIdSafe('brush-max-volume', false);
    brushStopOnErrorCheckbox = getElementByIdSafe('brush-stop-on-error', false);
    brushRuntimeSpan = getElementByIdSafe('brush-runtime', false);
    brushCountSpan = getElementByIdSafe('brush-count', false);
    brushVolumeSpan = getElementByIdSafe('brush-volume', false);
    brushFeesSpan = getElementByIdSafe('brush-fees', false);
    brushLossSpan = getElementByIdSafe('brush-loss', false);
    brushStatusSpan = getElementByIdSafe('brush-status', false);
    startBrushBtn = getElementByIdSafe('start-brush-btn', false);
    stopBrushBtn = getElementByIdSafe('stop-brush-btn', false);
}

function initEventListeners() {
    const tabGridBtn = getElementByIdSafe('tabGridBtn', false);
    const tabBrushBtn = getElementByIdSafe('tabBrushBtn', false);
    const tabSetBtn = getElementByIdSafe('tabSetBtn', false);
    const tabLogBtn = getElementByIdSafe('tabLogBtn', false);

    if (tabGridBtn) tabGridBtn.addEventListener('click', (e) => switchTab('tabGrid', e.target));
    if (tabBrushBtn) tabBrushBtn.addEventListener('click', (e) => switchTab('tabBrush', e.target));
    if (tabSetBtn) tabSetBtn.addEventListener('click', (e) => switchTab('tabSet', e.target));
    if (tabLogBtn) tabLogBtn.addEventListener('click', (e) => switchTab('tabLog', e.target));
    
    if (calculateGridBtn) calculateGridBtn.addEventListener('click', calculateGridLevels);
    if (startGridBtn) startGridBtn.addEventListener('click', startGridTrading);
    if (stopGridBtn) stopGridBtn.addEventListener('click', () => stopGridTrading(true));
    if (forceRebalanceBtn) forceRebalanceBtn.addEventListener('click', forceRebalanceGrid);

    // 🚀 速刷模式按钮
    if (startBrushBtn) startBrushBtn.addEventListener('click', startBrushMode);
    if (stopBrushBtn) stopBrushBtn.addEventListener('click', stopBrushMode);

    // ✅ 一键清仓按钮
    const emergencySellBtn = getElementByIdSafe('emergency-sell-btn', false);
    if (emergencySellBtn) emergencySellBtn.addEventListener('click', emergencySellAll);

    // ✅ 刷新实际余额按钮
    const refreshBalanceBtn = getElementByIdSafe('refresh-balance-btn', false);
    if (refreshBalanceBtn) {
        refreshBalanceBtn.addEventListener('click', async () => {
            addMessage('🔄 正在查询实际账户余额...', 'info');
            await updateUnrealizedPnLDisplay(true);  // 使用实际余额更新
            addMessage('✓ 实际余额已更新', 'success');
        });
    }
    
    if (gridSymbolInput) {
        gridSymbolInput.addEventListener('change', async () => {
            let newSymbol = gridSymbolInput.value.trim().toUpperCase();

            // ✅ 自动修正：如果没有USDT后缀，自动添加
            if (newSymbol && !newSymbol.endsWith('USDT')) {
                newSymbol = newSymbol + 'USDT';
                gridSymbolInput.value = newSymbol;
                addMessage(`✓ 已自动修正交易对: ${newSymbol}`, 'info');
            }

            if (newSymbol === gridConfig.symbol && instrumentInfo[newSymbol]) return;

            gridConfig.symbol = newSymbol;
            await getInstrumentInfo(gridConfig.symbol);
            initializePriceWebSocket();

            gridOrders.clear();
            activeBuyOrdersPerLevel.clear();
            activeSellOrdersPerLevel.clear();
            renderGridPreviewTable();

            if (isGridRunning) {
                addMessage(`交易对已更改，停止旧网格...`, 'warning');
                await stopGridTrading(true);
            }

            await calculateGridLevels();
        });
    }
    
    const saveConfigBtn = getElementByIdSafe('save-config-btn', false);
    const loadConfigBtn = getElementByIdSafe('load-config-btn', false);
    const getFeeBtn = getElementByIdSafe('get-fee-btn', false);
    
    if (saveConfigBtn) saveConfigBtn.addEventListener('click', saveConfig); 
    if (loadConfigBtn) loadConfigBtn.addEventListener('click', loadConfig); 
    if (getFeeBtn) getFeeBtn.addEventListener('click', getFeeRate);
    
    const toggleBtn = getElementByIdSafe('toggle-btn', false);
    const testCommBtn = getElementByIdSafe('test-communication-btn', false);
    
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'toggleSidebar' }));
    }
    
    if (testCommBtn) {
        testCommBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'testCommunication' }, (response) => {
                addMessage(`通信测试: ${response?.message || '失败'}`, response?.success ? 'success' : 'error');
            });
        });
    }
}

async function initPage() { 
    initDOMElements(); 
    initEventListeners(); 
    switchTab('tabGrid', getElementByIdSafe('tabGridBtn', false)); 
    updateGridUIState(); 
    
    addMessage("🚀 智能响应式网格交易助手已加载", 'info');
    
    await syncServerTime();
    const configLoaded = await loadConfig();

    let initialSymbol = (gridSymbolInput && gridSymbolInput.value) ? gridSymbolInput.value.trim().toUpperCase() : gridConfig.symbol;

    // ✅ 自动修正：确保交易对以USDT结尾
    if (initialSymbol && !initialSymbol.endsWith('USDT')) {
        initialSymbol = initialSymbol + 'USDT';
        if (gridSymbolInput) gridSymbolInput.value = initialSymbol;
        addMessage(`✓ 已自动修正交易对: ${initialSymbol}`, 'info');
    }

    await getInstrumentInfo(initialSymbol); 
    
    if (API_KEY && API_SECRET) {
        await getFeeRate();
        initializeOrderWebSocket();
    } else if (!configLoaded) {
        addMessage("ℹ️ API密钥未配置，将使用轮询方式监控订单", "info");
        addMessage("✓ Cookie 模式: 下单和撤单功能正常可用", "success");
    }
    
    initializePriceWebSocket(); 
    
    setInterval(syncServerTime, 60000); 
}

// ==================== Config Storage ====================

async function encryptConfig(config, password) { 
    try {
        const encoder = new TextEncoder(); 
        const data = encoder.encode(JSON.stringify(config)); 
        const iv = crypto.getRandomValues(new Uint8Array(12)); 
        
        const keyMaterial = await crypto.subtle.importKey( 
            'raw', 
            encoder.encode(password.padEnd(32, '\0').slice(0,32)), 
            { name: 'PBKDF2' }, 
            false, 
            ['deriveKey'] 
        );
        
        const derivedKey = await crypto.subtle.deriveKey( 
            { name: 'PBKDF2', salt: iv, iterations: 100000, hash: 'SHA-256' }, 
            keyMaterial, 
            { name: 'AES-GCM', length: 256 }, 
            true, 
            ['encrypt'] 
        );
        
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, derivedKey, data);
        
        return { 
            iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''), 
            encrypted: Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, '0')).join('') 
        };
    } catch (error) { 
        addMessage(`加密失败: ${error.message}`, 'error'); 
        throw error; 
    }
}

async function decryptConfig(encryptedData, password) { 
    try {
        const encoder = new TextEncoder(); 
        const iv = new Uint8Array(encryptedData.iv.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        const encrypted = new Uint8Array(encryptedData.encrypted.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        
        const keyMaterial = await crypto.subtle.importKey( 
            'raw', 
            encoder.encode(password.padEnd(32, '\0').slice(0,32)), 
            { name: 'PBKDF2' }, 
            false, 
            ['deriveKey'] 
        );
        
        const derivedKey = await crypto.subtle.deriveKey( 
            { name: 'PBKDF2', salt: iv, iterations: 100000, hash: 'SHA-256' }, 
            keyMaterial, 
            { name: 'AES-GCM', length: 256 }, 
            true, 
            ['decrypt'] 
        );
        
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, derivedKey, encrypted);
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch (error) { 
        addMessage(`解密失败: 密码错误或数据损坏`, 'error'); 
        throw error; 
    }
}

async function saveConfig() { 
    const currentPassword = passwordInput ? passwordInput.value : ''; 
    if (!currentPassword) { 
        addMessage('请输入配置密码以保存', 'error'); 
        return; 
    }
    
    const configToSave = {
        apiKey: apiKeyInput ? apiKeyInput.value.trim() : '',
        apiSecret: apiSecretInput ? apiSecretInput.value.trim() : '',
        gridSymbol: gridSymbolInput ? gridSymbolInput.value.trim().toUpperCase() : 'NXPCUSDT',
        profitPercent: profitPercentInput ? profitPercentInput.value : '2.5',
        gridCount: gridCountInput ? gridCountInput.value : '10',
        capitalPercent: capitalPercentInput ? capitalPercentInput.value : '100',
        rebalanceThreshold: rebalanceThresholdInput ? rebalanceThresholdInput.value : '15',
        checkInterval: checkIntervalInput ? checkIntervalInput.value : '10',
        autoRebalanceEnabled: autoRebalanceCheckbox ? autoRebalanceCheckbox.checked : true,
        // 🛡️ 止损配置
        gridStoplossEnabled: gridStoplossEnabledCheckbox ? gridStoplossEnabledCheckbox.checked : true,
        gridStoplossPercent: gridStoplossPercentInput ? gridStoplossPercentInput.value : '5',
        totalStoplossEnabled: totalStoplossEnabledCheckbox ? totalStoplossEnabledCheckbox.checked : true,
        totalStoplossUsdt: totalStoplossUsdtInput ? totalStoplossUsdtInput.value : '10'
    };
    
    try { 
        const encryptedConfig = await encryptConfig(configToSave, currentPassword); 
        chrome.storage.local.set({ encryptedBybitGridConfig: encryptedConfig }, () => { 
            addMessage('配置已加密保存', 'success'); 
            API_KEY = configToSave.apiKey; 
            API_SECRET = configToSave.apiSecret; 
        }); 
    } catch (error) { 
        addMessage('保存配置失败', 'error'); 
    }
}

async function loadConfig() { 
    const currentPassword = passwordInput ? passwordInput.value : ''; 
    if (!currentPassword) { 
        return false; 
    } 
    
    return new Promise((resolve) => {
        chrome.storage.local.get(['encryptedBybitGridConfig'], async (result) => {
            if (!result.encryptedBybitGridConfig) { 
                resolve(false); 
                return; 
            }
            
            try {
                const config = await decryptConfig(result.encryptedBybitGridConfig, currentPassword);
                
                if(apiKeyInput) apiKeyInput.value = config.apiKey || ''; 
                if(apiSecretInput) apiSecretInput.value = config.apiSecret || '';
                API_KEY = config.apiKey || ''; 
                API_SECRET = config.apiSecret || '';
                
                if(gridSymbolInput) gridSymbolInput.value = config.gridSymbol || 'NXPCUSDT';
                if(profitPercentInput) profitPercentInput.value = config.profitPercent || '2.5';
                if(gridCountInput) gridCountInput.value = config.gridCount || '10';
                if(capitalPercentInput) capitalPercentInput.value = config.capitalPercent || '100';
                if(rebalanceThresholdInput) rebalanceThresholdInput.value = config.rebalanceThreshold || '15';
                if(checkIntervalInput) checkIntervalInput.value = config.checkInterval || '10';
                if(autoRebalanceCheckbox) autoRebalanceCheckbox.checked = config.autoRebalanceEnabled !== false;

                // 🛡️ 加载止损配置
                if(gridStoplossEnabledCheckbox) gridStoplossEnabledCheckbox.checked = config.gridStoplossEnabled !== false;
                if(gridStoplossPercentInput) gridStoplossPercentInput.value = config.gridStoplossPercent || '5';
                if(totalStoplossEnabledCheckbox) totalStoplossEnabledCheckbox.checked = config.totalStoplossEnabled !== false;
                if(totalStoplossUsdtInput) totalStoplossUsdtInput.value = config.totalStoplossUsdt || '10';

                gridConfig.symbol = config.gridSymbol || 'NXPCUSDT'; 
                
                addMessage('配置已加载并解密', 'success'); 
                resolve(true); 
            } catch (error) { 
                resolve(false); 
            }
        });
    });
}

// ==================== Start Application ====================

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('grid-symbol') && document.querySelector('div.container')) {
        console.log("智能响应式网格交易系统初始化中...");
        initPage();
    }
});