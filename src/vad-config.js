export function buildServerVadConfig() {
  return {
    type: "server_vad",
    threshold: 0.5,
    silence_duration_ms: 400,
    prefix_padding_ms: 500,
  };
}
