import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, spin, leadSuburb, leadState, cleanBusinessName, inWindowTz } from '../components/templating.js'
import { stripQuoted, findBouncedAddress } from '../components/imap.js'

const lead = { name: 'Smith Bros Plumbing Pty Ltd', category: 'Plumber', address: '12 Main North Rd, Salisbury SA 5108, Australia', rating: 3.8, reviewCount: 12 }

test('fills tokens and cleans the business name', () => {
  const out = render('Hi {{name}} team, {{category}} work in {{suburb}} {{state}}? {{sender}}', lead, { fromName: 'Callum Robertson' })
  assert.equal(out, 'Hi Smith Bros Plumbing team, plumber work in Salisbury SA? Callum')
})

test('spintax picks one option and leaves no braces', () => {
  for (let i = 0; i < 50; i++) {
    const out = render('{Hey|Hi|G’day} {{name}}, {quick|short} {question|one}', lead)
    assert.match(out, /^(Hey|Hi|G’day) Smith Bros Plumbing, (quick|short) (question|one)$/)
  }
  assert.equal(spin('no spin here'), 'no spin here')
})

test('unknown tokens are left visible so mistakes are obvious', () => {
  assert.equal(render('Hi {{firstName}}', lead), 'Hi {{firstName}}')
})

test('suburb and state from Google addresses', () => {
  assert.equal(leadSuburb(lead), 'Salisbury'); assert.equal(leadState(lead), 'SA')
  assert.equal(leadSuburb({ address: 'Unit 3/45 Smith St, Fitzroy VIC 3065, Australia' }), 'Fitzroy')
  assert.equal(leadState({ address: '1 George St, Sydney NSW 2000, Australia' }), 'NSW')
  assert.equal(cleanBusinessName('ABC Roofing Pty. Ltd.'), 'ABC Roofing')
})

test('sending window respects hours and weekends', () => {
  const s = { windowStart: 8, windowEnd: 17, weekdaysOnly: true }
  // Wed 22 Oct 2026 10:00 Adelaide = 23:30 UTC on the 21st
  assert.equal(inWindowTz(s, 'Australia/Adelaide', new Date('2026-10-21T23:30:00Z')), true)
  // Same instant is 7:30am in Perth → outside
  assert.equal(inWindowTz(s, 'Australia/Perth', new Date('2026-10-21T23:30:00Z')), false)
  // Saturday 24 Oct 2026 11:00 Adelaide
  assert.equal(inWindowTz(s, 'Australia/Adelaide', new Date('2026-10-24T00:30:00Z')), false)
})

test('quoted history is stripped from replies', () => {
  const t = 'Yeah keen, call me Tuesday\n\nOn Wed, 22 Oct 2026 at 10:01, Callum <c@gmail.com> wrote:\n> Hi there\n> quick question'
  assert.equal(stripQuoted(t), 'Yeah keen, call me Tuesday')
})

test('finds the bounced address in a Gmail bounce', () => {
  const t = "Address not found\n\nYour message wasn't delivered to info@deadbiz.com.au because the address couldn't be found.\n\nFinal-Recipient: rfc822; info@deadbiz.com.au"
  assert.equal(findBouncedAddress(t, ['one@gmail.com']), 'info@deadbiz.com.au')
})
