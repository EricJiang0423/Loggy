import { expect, test } from 'vitest';
import { priceFor } from '../src/core/pricing';

// Official list prices (USD per 1M tokens), checked 2026-10-06.
test.each([
  ['glm-5.3', 1.4, 4.4, 0.26],
  ['proxy/glm-5.3', 1.4, 4.4, 0.26],
  ['gateway/glm53flash', 0.15, 0.5, 0.03],
  ['GLM-5.3-Flash', 0.15, 0.5, 0.03],
  ['deepseek-v4-flash', 0.3, 1.2, 0.006],
  ['deepseek-v4.1-flash', 0.3, 1.2, 0.006],
  ['deepseek-v4-pro', 1.32, 3.96, 0.044],
  ['kimi/k3', 3, 15, 0.3],
  ['kimi-k3-1m', 3, 15, 0.3],
  ['kimi-code/k3', 3, 15, 0.3],
  ['kimi-code/k3-256k', 3, 15, 0.3],
  ['mimo/mimo-v2.6-pro', 0.435, 0.87, 0.0036],
  ['mimo/mimo-v2.6-flash', 0.14, 0.28, 0.0028],
  ['gpt-6-astra', 10, 50, 1],
  ['gpt-6.1-sol', 2, 10, 0.1],
  ['gpt-6-sol', 2, 10, 0.2],
  ['gpt-6-luna', 0.1, 0.5, 0.01],
  ['gpt-5.6-sol', 4, 20, 0.4],
  ['proxy/gpt-5.6-sol', 4, 20, 0.4],
  ['gpt-5.6-terra', 2, 12, 0.2],
  ['gpt-5.6-luna', 0.2, 1.2, 0.02],
  ['gpt-5.5', 5, 30, 0.5],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-sonnet-4-6', 3, 15, 0.3],
])('%s', (model, input, output, cacheRead) => {
  expect(priceFor(model)).toMatchObject({ input, output, cacheRead });
});
