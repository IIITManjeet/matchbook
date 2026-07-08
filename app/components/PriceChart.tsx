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

const UP = "#26a69a";
const DOWN = "#ef5350";

export default function PriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const seededRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8b98a5",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#171c23" },
        horzLines: { color: "#171c23" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#5a6673", labelBackgroundColor: "#222933" },
        horzLine: { color: "#5a6673", labelBackgroundColor: "#222933" },
      },
      rightPriceScale: { borderColor: "#222933" },
      timeScale: {
        borderColor: "#222933",
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
      color: c.close >= c.open ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)",
    });

    const apply = (candles: Candle[]) => {
      const cs = candleSeriesRef.current;
      const vs = volumeSeriesRef.current;
      if (!cs || !vs || candles.length === 0) return;
      if (!seededRef.current) {
        cs.setData(candles.map(toBar));
        vs.setData(candles.map(toVol));
        chartRef.current?.timeScale().scrollToRealTime();
        seededRef.current = true;
      } else {
        const last = candles[candles.length - 1];
        cs.update(toBar(last));
        vs.update(toVol(last));
      }
    };

    apply(useTerminal.getState().candles);
    return useTerminal.subscribe((s) => apply(s.candles));
  }, []);

  const feedSource = useTerminal((s) => s.feedSource);
  const symbol = useTerminal((s) => s.market.symbol);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-4">
        <span className="text-xs font-semibold text-ink">{symbol}</span>
        <span className="rounded-md bg-panel2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
          1m
        </span>
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
