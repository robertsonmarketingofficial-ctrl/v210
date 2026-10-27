// State locking for Lead Finder / AFK searches. Google's API is faked, so
// this checks exactly what we ask Google for and what we keep from its reply.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLocation, detectState, searchPlacesNew } from '../pages/api/search.js'

test('parseLocation pulls the state off the end of a location', () => {
  assert.deepEqual(parseLocation('Brighton VIC'), { place: 'Brighton', state: 'VIC' })
  assert.deepEqual(parseLocation('Norwood, South Australia'), { place: 'Norwood', state: 'SA' })
  assert.deepEqual(parseLocation('Richmond', 'vic'), { place: 'Richmond', state: 'VIC' })
  assert.deepEqual(parseLocation('Melbourne CBD'), { place: 'Melbourne CBD', state: null })
})

test('detectState reads Google-formatted AU addresses', () => {
  assert.equal(detectState('12 Swan St, Richmond VIC 3121, Australia'), 'VIC')
  assert.equal(detectState('4 Hay St, Perth WA 6000, Australia'), 'WA')
  assert.equal(detectState('1 London Cct, Canberra ACT 2601, Australia'), 'ACT')
  assert.equal(detectState('Unit 2, Richmond 7025, Australia'), 'TAS') // postcode fallback
  assert.equal(detectState('Somewhere, Australia'), null)
})

test('landscapers in VIC: query names Victoria and WA results are dropped', async () => {
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body))
    return { json: async () => ({ places: [
      { id: 'v1', displayName: { text: 'Richmond Gardens' }, formattedAddress: '5 Church St, Richmond VIC 3121, Australia' },
      { id: 'w1', displayName: { text: 'Perth Lawns' }, formattedAddress: '9 Hay St, Perth WA 6000, Australia' },
      { id: 'n1', displayName: { text: 'Richmond NSW Landscaping' }, formattedAddress: '1 March St, Richmond NSW 2753, Australia' },
    ] }) }
  }
  try {
    const r = await searchPlacesNew('landscapers', 'Richmond', 'key', 1, 'VIC')
    assert.equal(sent[0].textQuery, 'landscapers in Richmond, Victoria, Australia')
    assert.deepEqual(r.leads.map(l => l.id), ['v1'])
    assert.equal(r.outOfState, 2)

    // Lead Finder sweep labels like "Brighton VIC" don't double up the state
    await searchPlacesNew('landscapers', 'Brighton VIC', 'key', 1, 'VIC')
    assert.equal(sent[1].textQuery, 'landscapers in Brighton, Victoria, Australia')

    // No state known -> previous behaviour, nothing filtered
    const all = await searchPlacesNew('landscapers', 'Melbourne CBD', 'key', 1)
    assert.equal(sent[2].textQuery, 'landscapers Melbourne CBD, Australia')
    assert.equal(all.leads.length, 3)
  } finally {
    globalThis.fetch = realFetch
  }
})
