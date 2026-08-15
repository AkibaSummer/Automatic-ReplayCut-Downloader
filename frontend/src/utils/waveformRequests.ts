export type WaveformRequestToken = {
  chunkIndex: number
  generation: number
  controller: AbortController
}

/**
 * Keeps waveform requests scoped to the video that created them.
 *
 * A generation check prevents a response that is already being decoded from
 * updating a newer video. Token identity prevents an old request's cleanup
 * from deleting a newer request for the same chunk index.
 */
export class WaveformRequestRegistry {
  private generation = 0
  private readonly inflight = new Map<number, WaveformRequestToken>()

  beginSession() {
    this.generation += 1
    for (const token of this.inflight.values()) token.controller.abort()
    this.inflight.clear()
    return this.generation
  }

  isGenerationCurrent(generation: number) {
    return generation === this.generation
  }

  get size() {
    return this.inflight.size
  }

  has(chunkIndex: number) {
    return this.inflight.has(chunkIndex)
  }

  entries() {
    return this.inflight.entries()
  }

  create(chunkIndex: number): WaveformRequestToken | null {
    if (this.inflight.has(chunkIndex)) return null
    const token = {
      chunkIndex,
      generation: this.generation,
      controller: new AbortController(),
    }
    this.inflight.set(chunkIndex, token)
    return token
  }

  owns(token: WaveformRequestToken) {
    return this.inflight.get(token.chunkIndex) === token
  }

  isCurrent(token: WaveformRequestToken) {
    return this.isGenerationCurrent(token.generation)
      && this.owns(token)
      && !token.controller.signal.aborted
  }

  abort(token: WaveformRequestToken) {
    if (!this.owns(token)) return
    token.controller.abort()
    this.inflight.delete(token.chunkIndex)
  }

  finish(token: WaveformRequestToken) {
    if (this.owns(token)) this.inflight.delete(token.chunkIndex)
  }
}
