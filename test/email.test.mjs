// End-to-end test of the real mailer against a local SMTP server.
// Run: npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { SMTPServer } from 'smtp-server'

const GOOD_PASS = 'abcdefghijklmnop'
const received = []
let server

before(async () => {
  server = new SMTPServer({
    disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authOptional: false, logger: false,
    onAuth(auth, session, cb) {
      if (auth.password === GOOD_PASS) return cb(null, { user: auth.username })
      const err = new Error('5.7.8 Username and Password not accepted'); err.responseCode = 535; cb(err)
    },
    onRcptTo(addr, session, cb) {
      if (addr.address.startsWith('bounce@')) { const err = new Error('5.1.1 Recipient address rejected: no such user'); err.responseCode = 550; return cb(err) }
      if (addr.address.startsWith('quota@')) { const err = new Error('5.4.5 Daily user sending limit exceeded'); err.responseCode = 550; return cb(err) }
      cb()
    },
    onData(stream, session, cb) {
      let body = ''
      stream.on('data', c => { body += c })
      stream.on('end', () => { received.push({ from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map(r => r.address), authUser: session.user, body }); cb() })
    },
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  process.env.SMTP_HOST = '127.0.0.1'
  process.env.SMTP_PORT = String(server.server.address().port)
  process.env.SMTP_SECURE = 'false'
  process.env.GMAIL_USERS = 'one@gmail.com, two@gmail.com ,"three@gmail.com",bad@gmail.com'
  process.env.GMAIL_APP_PASSWORDS = 'abcd efgh ijkl mnop,"abcd efgh ijkl mnop",abcdefghijklmnop,wrongpassword123'
})
after(() => new Promise(r => server.close(r)))
const load = () => import('../components/mailer.js')

test('parses accounts with spaces and quotes', async () => {
  const { getAccounts } = await load()
  assert.deepEqual(getAccounts().map(a => a.user), ['one@gmail.com', 'two@gmail.com', 'three@gmail.com', 'bad@gmail.com'])
  assert.equal(getAccounts()[0].pass, GOOD_PASS)
})

test('sends from exactly the inbox it is told to', async () => {
  const { sendFrom } = await load()
  const r = await sendFrom({ from: 'two@gmail.com', to: 'lead@biz.com.au', subject: 'quick question', text: 'Hi there' })
  assert.equal(r.success, true)
  assert.equal(r.sentFrom, 'two@gmail.com')
  const last = received.at(-1)
  assert.equal(last.authUser, 'two@gmail.com')
  assert.deepEqual(last.to, ['lead@biz.com.au'])
})

test('follow-ups carry threading headers', async () => {
  const { sendFrom } = await load()
  const r = await sendFrom({ from: 'one@gmail.com', to: 'lead@biz.com.au', subject: 'Re: quick question', text: 'Bump', inReplyTo: '<abc@x>', references: ['<abc@x>'] })
  assert.equal(r.success, true)
  const body = received.at(-1).body
  assert.match(body, /In-Reply-To: <abc@x>/)
  assert.match(body, /References: <abc@x>/)
})

test('unknown inbox is refused without sending', async () => {
  const { sendFrom } = await load()
  const before = received.length
  const r = await sendFrom({ from: 'nope@gmail.com', to: 'lead@biz.com.au', text: 'x' })
  assert.equal(r.success, false); assert.equal(r.kind, 'config'); assert.equal(received.length, before)
})

test('bad recipient is classified as recipient', async () => {
  const { sendFrom } = await load()
  const r = await sendFrom({ from: 'one@gmail.com', to: 'bounce@biz.com.au', text: 'x' })
  assert.equal(r.success, false); assert.equal(r.kind, 'recipient')
})

test('gmail daily limit is classified as quota', async () => {
  const { sendFrom } = await load()
  const r = await sendFrom({ from: 'one@gmail.com', to: 'quota@biz.com.au', text: 'x' })
  assert.equal(r.success, false); assert.equal(r.kind, 'quota')
})

test('wrong app password is classified as auth', async () => {
  const { sendFrom } = await load()
  const r = await sendFrom({ from: 'bad@gmail.com', to: 'lead@biz.com.au', text: 'x' })
  assert.equal(r.success, false); assert.equal(r.kind, 'auth')
})

test('verifyAccounts reports each login', async () => {
  const { verifyAccounts } = await load()
  const v = await verifyAccounts()
  assert.equal(v.accountCount, 4); assert.equal(v.okCount, 3)
  assert.equal(v.accounts.find(a => a.user === 'bad@gmail.com').ok, false)
})
