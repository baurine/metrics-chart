import React, {
  useRef,
  useState,
  useContext,
  useCallback,
  useMemo,
  useEffect,
} from 'react'

import {
  Chart,
  Settings,
  Position,
  Axis,
  ScaleType,
  LineSeries,
  BrushEvent,
  PointerEvent,
} from '@elastic/charts'
import { AxiosPromise } from 'axios'
import { getValueFormat } from '@baurine/grafana-value-formats'
import format from 'string-template'

import {
  TimeRangeValue,
  IQueryConfig,
  TransformNullValue,
  MetricsQueryResponse,
  QueryOptions,
  QueryData,
} from './interfaces'
import {
  processRawData,
  PromMatrixData,
  resolveQueryTemplate,
} from '../utils/prometheus'
import {
  alignRange,
  DEFAULT_CHART_SETTINGS,
  timeTickFormatter,
  useChartHandle,
} from '../utils/charts'

import tz from '../utils/timezone'

import { useChange } from '../utils/useChange'
import { renderQueryData } from './seriesRenderer'
import { ChartContext } from './SyncChartContext'

export interface IMetricChartProps {
  queries: IQueryConfig[]
  range: TimeRangeValue
  unit?: string
  nullValue?: TransformNullValue
  height?: number
  timezone?: number
  onError?: (err: Error | null) => void
  onLoading?: (isLoading: boolean) => void
  onBrush?: (newRange: TimeRangeValue) => void
  onClickSeriesLabel?: (seriesName: string) => void
  fetchPromeData: (params: {
    endTimeSec: number
    query: string
    startTimeSec: number
    stepSec: number
  }) => AxiosPromise<MetricsQueryResponse>
}

type Data = {
  meta: {
    queryOptions: QueryOptions
  }
  values: QueryData[]
}

const MetricsChart = ({
  queries,
  range,
  unit,
  nullValue = TransformNullValue.NULL,
  height = 200,
  timezone,
  onBrush,
  onError,
  onLoading,
  fetchPromeData,
  onClickSeriesLabel,
}: IMetricChartProps) => {
  const chartRef = useRef<Chart>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const [chartHandle] = useChartHandle(chartContainerRef, 150)
  const ee = useContext(ChartContext)
  ee.useSubscription(e => chartRef.current?.dispatchExternalPointerEvent(e))

  const getQueryOptions = (range: TimeRangeValue): QueryOptions => {
    const interval = chartHandle.calcIntervalSec(range)
    const rangeSnapshot = alignRange(range, interval) // Align the range according to calculated interval
    const queryOptions: QueryOptions = {
      start: rangeSnapshot[0],
      end: rangeSnapshot[1],
      step: interval,
    }
    return queryOptions
  }

  const [data, setData] = useState<Data | null>(() => {
    const initData: Data = {
      meta: {
        queryOptions: getQueryOptions(range),
      },
      values: [],
    }
    return initData
  })

  useChange(() => {
    const queryOptions = getQueryOptions(range)

    async function queryMetric(
      queryTemplate: string,
      fillIdx: number,
      fillInto: (PromMatrixData | null)[]
    ) {
      const query = resolveQueryTemplate(queryTemplate, queryOptions)
      const pramas = {
        endTimeSec: queryOptions.end,
        query: query,
        startTimeSec: queryOptions.start,
        stepSec: queryOptions.step,
      }
      try {
        const resp = await fetchPromeData(pramas)
        let data: PromMatrixData | null = null
        if (resp.data.status === 'success') {
          data = resp.data.data as any
          if (data?.resultType !== 'matrix') {
            // unsupported
            data = null
          }
        }
        fillInto[fillIdx] = data
      } catch (e) {
        fillInto[fillIdx] = null
        onError?.(e)
      }
    }

    async function queryAllMetrics() {
      onLoading?.(true)
      const dataSets: (PromMatrixData | null)[] = []
      try {
        await Promise.all(
          queries.map((q, idx) => queryMetric(q.promql, idx, dataSets))
        )
      } finally {
        onLoading?.(false)
      }

      // Transform response into data
      const sd: QueryData[] = []
      dataSets.forEach((data, queryIdx) => {
        if (!data) {
          return
        }
        data.result.forEach((promResult, seriesIdx) => {
          const data = processRawData(promResult, queryOptions)
          if (data === null) {
            return
          }

          // transform data according to nullValue config
          const transformedData =
            nullValue === TransformNullValue.AS_ZERO
              ? data.map(d => {
                  if (d[1] !== null) {
                    return d
                  }
                  d[1] = 0
                  return d
                })
              : data

          const d: QueryData = {
            id: `${queryIdx}_${seriesIdx}`,
            name: format(queries[queryIdx].name, promResult.metric),
            data: transformedData,
            type: queries[queryIdx].type,
            color: queries[queryIdx].color,
          }
          sd.push(d)
        })
      })
      setData({
        meta: {
          queryOptions,
        },
        values: sd,
      })
    }

    queryAllMetrics()
  }, [range])

  useEffect(() => {
    if (typeof timezone === 'number') {
      tz.setTimeZone(timezone)
    }
  }, [])

  const handleBrushEnd = useCallback(
    (ev: BrushEvent) => {
      if (!ev.x) {
        return
      }
      const timeRange: TimeRangeValue = [
        Math.floor((ev.x[0] as number) / 1000),
        Math.floor((ev.x[1] as number) / 1000),
      ]
      onBrush?.(alignRange(timeRange))
    },
    [onBrush]
  )

  const handleLegendItemClick = e => {
    const seriesName = e[0].specId
    onClickSeriesLabel?.(seriesName)
  }

  return (
    <div ref={chartContainerRef}>
      <Chart size={{ height }} ref={chartRef}>
        <Settings
          {...DEFAULT_CHART_SETTINGS}
          legendPosition={Position.Right}
          legendSize={130}
          pointerUpdateDebounce={0}
          onPointerUpdate={e => ee.emit(e)}
          xDomain={{ min: range[0] * 1000, max: range[1] * 1000 }}
          onBrushEnd={handleBrushEnd}
          onLegendItemClick={handleLegendItemClick}
        />
        <Axis
          id="bottom"
          position={Position.Bottom}
          showOverlappingTicks
          tickFormat={timeTickFormatter(range)}
        />
        <Axis
          id="left"
          position={Position.Left}
          showOverlappingTicks
          tickFormat={v =>
            unit ? getValueFormat(unit)(v, 1) : getValueFormat('none')(v)
          }
          ticks={5}
        />
        {data?.values.map((qd, idx) => (
          <React.Fragment key={idx}>{renderQueryData(qd)}</React.Fragment>
        ))}
        {data && (
          <LineSeries // An empty series to avoid "no data" notice
            id="_placeholder"
            xScaleType={ScaleType.Time}
            yScaleType={ScaleType.Linear}
            xAccessor={0}
            yAccessors={[1]}
            hideInLegend
            data={[
              [data.meta.queryOptions.start * 1000, 0],
              [data.meta.queryOptions.end * 1000, 0],
            ]}
          />
        )}
      </Chart>
    </div>
  )
}

export default MetricsChart
