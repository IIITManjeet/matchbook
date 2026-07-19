"use client";

import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useTerminal } from "@/lib/store";
import type { Candle } from "@/lib/types";

const UP = "#2ebd85";
const DOWN = "#f6465d";

const INTERVALS: { label: string; secs: number }[] = [
  { label: "1m", secs: 60 },
  { label: "5m", secs: 300 },
  { label: "15m", secs: 900 },
  { label: "1h", secs: 3600 },
  { label: "4h", secs: 14400 },
  { label: "1d", secs: 86400 },
];

export default function PriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const seededRef = useRef(false);
  /** resolution of the data currently on the chart; a mismatch with the
   *  snapshot's interval means the refetched series arrived → reseed */
  const appliedIntervalRef = useRef(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9aa8bc",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1f2838" },
        horzLines: { color: "#1f2838" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#6b7990", labelBackgroundColor: "#273246" },
        horzLine: { color: "#6b7990", labelBackgroundColor: "#273246" },
      },
      rightPriceScale: { borderColor: "#2d3950" },
      timeScale: {
        borderColor: "#2d3950",
        timeVisible: true,
        secondsVisible: false,
      },
      autoSize: false,
    });

    const candles = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      priceLineColor: "#5a6673",
    });
    const volume = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      visible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candles;
    volumeSeriesRef.current = volume;

    const resize = () => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      seededRef.current = false;
    };
  }, []);

  useEffect(() => {
    const toBar = (c: Candle) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    });
    const toVol = (c: Candle) => ({
      time: c.time as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? "rgba(46,189,133,0.35)" : "rgba(246,70,93,0.35)",
    });

    const apply = (candles: Candle[], interval: number) => {
      const cs = candleSeriesRef.current;
      const vs = volumeSeriesRef.current;
      if (!cs || !vs || candles.length === 0) return;
      if (!seededRef.current || interval !== appliedIntervalRef.current) {
        cs.setData(candles.map(toBar));
        vs.setData(candles.map(toVol));
        chartRef.current?.timeScale().scrollToRealTime();
        seededRef.current = true;
        appliedIntervalRef.current = interval;
      } else {
        const last = candles[candles.length - 1];
        cs.update(toBar(last));
        vs.update(toVol(last));
      }
    };

    const s0 = useTerminal.getState();
    apply(s0.candles, s0.candleInterval);
    return useTerminal.subscribe((s) => apply(s.candles, s.candleInterval));
  }, []);

  const feedSource = useTerminal((s) => s.feedSource);
  const symbol = useTerminal((s) => s.market.symbol);
  const chartInterval = useTerminal((s) => s.chartInterval);
  const setChartInterval = useTerminal((s) => s.setChartInterval);
  // The simulator only fabricates 1m candles; higher intervals need the indexer.
  const switchable = feedSource === "indexer";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-4">
        <span className="text-xs font-semibold text-ink">{symbol}</span>
        <div className="flex items-center gap-0.5 rounded-md bg-panel2 p-0.5">
          {INTERVALS.map((iv) => (
            <button
              key={iv.secs}
              data-testid={`interval-${iv.label}`}
              onClick={() => switchable && setChartInterval(iv.secs)}
              disabled={!switchable && iv.secs !== 60}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                chartInterval === iv.secs
                  ? "bg-panel3 text-ink"
                  : "text-muted hover:text-ink disabled:opacity-40 disabled:hover:text-muted"
              }`}
            >
              {iv.label}
            </button>
          ))}
        </div>
        <span className="ml-auto rounded-md bg-panel2 px-2 py-0.5 text-[10px] text-faint">
          {feedSource === "indexer"
            ? symbol.endsWith("PERP")
              ? "oracle feed · on-chain data"
              : "indexer feed · on-chain data"
            : "mock data · simulator"}
        </span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
