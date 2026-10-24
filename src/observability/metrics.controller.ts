import { Controller, Get, Header } from '@nestjs/common';
import { Registry } from 'prom-client';
import { Metrics } from './metrics';

/** Prometheus scrape endpoint. No PII: labels are outcomes and statuses only. */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
