// Natural-looking emails your inboxes send each other during warmup.
// Varied on purpose: identical warmup emails are a pattern spam filters spot.

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

const GREETINGS = ['Hey', 'Hi', 'Hey mate', 'Morning', 'Hi there', 'G\'day', 'Afternoon']
const SIGNOFFS = ['Cheers', 'Thanks', 'Talk soon', 'Cheers mate', 'Thanks heaps', 'Catch ya']

const THREADS = [
  { s: ['Quick one', 'Quick question', 'Got a sec?'], b: [
    'Do you still have that list of suppliers from last month? Wanted to check a couple of prices before Friday.',
    'Are you around Thursday arvo for a quick catch up? Shouldn\'t take more than 15 mins.',
    'Did you end up finding a decent accountant? Mine\'s retiring at the end of the year.',
  ] },
  { s: ['Notes from today', 'Following up', 'Re-cap'], b: [
    'Just jotting down what we chatted about so I don\'t forget. Main thing is getting the quotes sorted before the end of the month.',
    'Wrote up the main points from the call. Let me know if I missed anything and I\'ll update it.',
    'Thanks for the chat earlier. I\'ll send through the numbers once I\'ve gone over them again.',
  ] },
  { s: ['Weekend plans', 'Footy this weekend?', 'Saturday'], b: [
    'Keen for a hit of golf Saturday morning if the weather holds up?',
    'Are you heading to the game on the weekend? Might grab tickets if a few of us are going.',
    'Looks like it\'ll be a nice weekend. Thinking of a barbie Sunday, you keen?',
  ] },
  { s: ['That article', 'Saw this and thought of you', 'Interesting read'], b: [
    'Read something yesterday about small business cash flow that was actually pretty useful. Remind me to send it through.',
    'Was listening to a podcast on hiring your first employee, had a few good points. Will dig up the name.',
    'Came across a write-up on local SEO for tradies, reckon it\'d be worth a look for a few of the clients.',
  ] },
  { s: ['Invoice', 'Paperwork', 'Admin stuff'], b: [
    'Have you had a chance to look over the invoice template? Want to lock it in before the next batch goes out.',
    'Just a reminder about the paperwork for next week. No rush, whenever you get a chance.',
    'Got the forms you sent, all looks good. I\'ll get them back to you tomorrow.',
  ] },
  { s: ['Meeting time', 'Next week', 'Schedule'], b: [
    'What does your week look like? Tuesday or Wednesday morning works best on my end.',
    'Can we push our catch up to next week? Something came up on Thursday.',
    'Locked in the room for Monday at 10. Let me know if that doesn\'t suit.',
  ] },
]

const REPLIES = [
  'Sounds good, thanks for letting me know.',
  'Yep all good on my end.',
  'Cheers, I\'ll have a look tonight.',
  'No worries at all, talk then.',
  'Legend, thanks for sending that through.',
  'Works for me. See you then.',
  'Good call, let\'s do it.',
  'Thanks mate, appreciate it.',
  'All sorted, I\'ll get back to you tomorrow.',
  'Haha yeah fair enough. Let me know how you go.',
]

// Only use the address as a name when it actually looks like a first name
// (e.g. "sam.jones@..." → "Sam"). Business-style addresses like
// "robertsonmarketingfacebook@..." get a plain greeting instead of
// "Hey Robertsonmarketingfacebook".
const NOT_NAMES = /^(info|admin|office|sales|hello|contact|enquiries|mail|team|support|accounts|jobs|robertson|marketing)/i
const firstName = (email) => {
  const local = String(email || '').split('@')[0].replace(/[0-9._-]+/g, ' ').trim().split(' ')[0] || ''
  if (!local || local.length < 3 || local.length > 10 || NOT_NAMES.test(local)) return ''
  return local[0].toUpperCase() + local.slice(1).toLowerCase()
}

export function warmupMessage(toEmail, fromName = 'Callum') {
  const t = pick(THREADS)
  const name = firstName(toEmail)
  const greeting = Math.random() < 0.5 && name ? `${pick(GREETINGS)} ${name},` : `${pick(GREETINGS)},`
  return {
    subject: pick(t.s),
    text: `${greeting}\n\n${pick(t.b)}\n\n${pick(SIGNOFFS)},\n${fromName}`,
  }
}

export function warmupReply(fromName = 'Callum') {
  return `${pick(REPLIES)}\n\n${pick(SIGNOFFS)},\n${fromName}`
}
