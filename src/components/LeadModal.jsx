import { useState } from 'react'

const inputCls =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-lg focus:border-blue-600 focus:outline-none'

export default function LeadModal({ open, onClose }) {
  const [form, setForm] = useState({ name: '', contact: '', website: '' })
  const [status, setStatus] = useState('idle') // idle | sending | done | error

  if (!open) return null

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  async function submit(e) {
    e.preventDefault()
    setStatus('sending')
    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error('request failed')
      setStatus('done')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-full w-full max-w-md overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-2xl font-bold text-gray-900">
            Get this for your company
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-3xl leading-none text-gray-400 hover:text-gray-600"
          >
            &times;
          </button>
        </div>

        {status === 'done' ? (
          <p className="mt-4 text-lg text-gray-700">
            Thanks — got it! I'll get back to you within a day.
          </p>
        ) : (
          <form onSubmit={submit}>
            <p className="mt-3 text-lg text-gray-700">
              <strong>$500 setup + $99/month — live in a week.</strong>
              <br />
              We import your customer list for you.
            </p>

            <label className="mt-4 block">
              <span className="text-sm font-medium uppercase tracking-wide text-gray-500">
                Name
              </span>
              <input
                className={inputCls}
                value={form.name}
                onChange={set('name')}
                required
              />
            </label>
            <label className="mt-3 block">
              <span className="text-sm font-medium uppercase tracking-wide text-gray-500">
                Email or phone
              </span>
              <input
                className={inputCls}
                value={form.contact}
                onChange={set('contact')}
                required
              />
            </label>

            {/* honeypot — humans never see or fill this */}
            <input
              type="text"
              name="website"
              value={form.website}
              onChange={set('website')}
              tabIndex="-1"
              autoComplete="off"
              aria-hidden="true"
              className="absolute -left-[9999px] h-0 w-0 opacity-0"
            />

            {status === 'error' && (
              <p className="mt-3 text-base text-red-700">
                Something went wrong — please try again, or just reply to my
                email.
              </p>
            )}

            <button
              type="submit"
              disabled={status === 'sending'}
              className="mt-4 w-full rounded-lg bg-blue-700 px-4 py-3 text-lg font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {status === 'sending' ? 'Sending…' : 'Send'}
            </button>
            <p className="mt-3 text-center text-base text-gray-500">
              …or just reply to my email.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
