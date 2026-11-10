import { Accordion, AccordionDetails, AccordionSummary, Chip, Stack, Typography } from '@mui/material';
import ExpandMore from '@mui/icons-material/ExpandMore';
import type { ModelRequestMeter } from './token-meter';
import { toolExecutionTypeMeta } from './tool-execution-type';
import { formatCost } from './request-cost';

export function RequestMeterCard({ meter }: { meter: ModelRequestMeter }) {
  const meta = toolExecutionTypeMeta.library;
  const money = (value: number | undefined, currency?: string) => value === undefined || !currency ? 'Cost unavailable' : `${formatCost(value)} ${currency}`;
  return <Accordion disableGutters defaultExpanded={false}
    sx={{
      alignSelf: 'flex-start', width: 'fit-content', maxWidth: { xs: '100%', md: '70%' }, minWidth: 0,
      flex: '0 1 auto', border: '1px solid', borderColor: 'divider', borderRadius: '8px',
      overflow: 'hidden', bgcolor: 'background.default', boxShadow: 'none',
      '&.MuiAccordion-root': { borderRadius: '8px' }, '&:before': { display: 'none' },
    }}>
    <AccordionSummary id={`meter-${meter.id}-summary`} aria-controls={`meter-${meter.id}-details`}
      expandIcon={<ExpandMore />} sx={{ minHeight: 34, py: 0 }}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0, width: '100%' }}>
        <Chip size="small" label={meta.label} sx={{ bgcolor: meta.background, color: meta.color }} />
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>js-tiktoken</Typography>
        <Chip size="small" color={meter.status === 'completed' ? 'success' : meter.status === 'failed' ? 'error' : 'default'} label={meter.status} />
      </Stack>
    </AccordionSummary>
    <AccordionDetails sx={{ pt: 0.5, minWidth: 0 }}>
      <Stack spacing={0.75} sx={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}>
        <Typography variant="caption" color="text.secondary">Model: {meter.model}{meter.actualModel && meter.actualModel !== meter.model ? ` → ${meter.actualModel}` : ''}</Typography>
        <Typography variant="body2">Estimated input tokens: {meter.estimatedInputTokens ?? 'Estimate unavailable'}</Typography>
        <Typography variant="body2">Estimated input cost: {money(meter.estimatedInputCost, meter.pricing?.currency)}</Typography>
        <Typography variant="body2">Actual input: {meter.actualInputTokens ?? 'Not reported'}</Typography>
        <Typography variant="body2">Actual output: {meter.actualOutputTokens ?? 'Not reported'}</Typography>
        <Typography variant="body2">Total: {meter.actualTotalTokens ?? 'Not reported'}</Typography>
        <Typography variant="body2">Estimated request cost: {money(meter.estimatedRequestCost, meter.actualPricing?.currency)}</Typography>
        {(meter.actualPricing ?? meter.pricing) && <Typography variant="caption" color="text.secondary">Rates: {(meter.actualPricing ?? meter.pricing)!.source} · {(meter.actualPricing ?? meter.pricing)!.asOf}</Typography>}
      </Stack>
    </AccordionDetails>
  </Accordion>;
}
