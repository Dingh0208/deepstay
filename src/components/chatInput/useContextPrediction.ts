import { useEffect, useMemo, useState } from 'react'
import { predictNextContext, type ContextPredictionOptions } from '../../services/chat/contextPrediction.js'
import type { ContextEstimate } from '../../services/chat/replyMetrics.js'

export const useContextPrediction = (
  options: Omit<ContextPredictionOptions, 'signal'>,
  paused: boolean
): { estimate?: ContextEstimate; estimating: boolean } => {
  const { session, text, files, system, tools, model, thinking, connection,
    inputBudget, memoryBudget, latestReminder } = options
  // The identity gates results immediately, including the render before effect cleanup runs.
  const request = useMemo(() => ({ session, text, files, system, tools, model, thinking, connection,
    inputBudget, memoryBudget, latestReminder, paused }), [session, text, files,
    system, tools, model, thinking, connection, inputBudget, memoryBudget, latestReminder, paused])
  const [result, setResult] = useState<{ request: typeof request; estimate?: ContextEstimate }>()
  useEffect(() => {
    if (paused) {
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void predictNextContext({ ...request, signal: controller.signal }).then((estimate) => {
        if (!controller.signal.aborted) {
          setResult({ request, estimate })
        }
      }).catch(() => {
        // A failed local read cannot block composing or substitute stale request statistics.
        if (!controller.signal.aborted) {
          setResult({ request })
        }
      })
    }, 400)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [request, paused])
  return {
    estimate: !paused && result?.request === request ? result.estimate : undefined,
    estimating: !paused && result?.request !== request,
  }
}
