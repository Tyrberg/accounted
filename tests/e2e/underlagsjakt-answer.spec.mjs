// Run with Playwright installed, against a running app with the extension enabled:
// UNDERLAGSJAKT_BASE_URL=http://localhost:3000 UNDERLAGSJAKT_STORAGE_STATE=<session.json> playwright test tests/e2e/underlagsjakt-answer.spec.mjs
// The storage state must belong to a Swedish-locale test user. All extension API writes are intercepted.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync(new URL('../../extensions/general/underlagsjakt/__tests__/fixtures/export-1.4.json', import.meta.url)))
const messages = JSON.parse(readFileSync(new URL('../../messages/sv.json', import.meta.url))).underlagsjakt
const api = '/api/extensions/ext/underlagsjakt'
test.use({
  baseURL: process.env.UNDERLAGSJAKT_BASE_URL || 'http://localhost:3000',
  storageState: process.env.UNDERLAGSJAKT_STORAGE_STATE,
})

async function openAnswer(page, forslag = null) {
  const summary = fixture.sammanstallningar[0]
  const post = {
    ...summary.posts[0], transaction_id: 'answer-e2e', motpart: 'SEB', belopp: -100,
    kategori: 'behover_mattias', forslag, kandidater: [], tvetydiga_alternativ: [],
  }
  const saves = []
  await page.route(`**${api}/**`, async (route) => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/svar')) {
      saves.push(route.request().postDataJSON())
      await route.fulfill({ json: { data: { beslut: { ...saves.at(-1), vald_kandidat: null } } } })
      return
    }
    if (route.request().method() !== 'GET') throw new Error('Unexpected extension write')
    await route.fulfill({ json: { data: {
      supported_export_versions: ['1.4'], answer_version: '1.4',
      leverans: { till_detta_bolag: false },
      export: { ...fixture, imported_at: fixture.generated_at, imported_via: 'fil', sammanstallningar: [summary] },
      posts: [post], answered: [], pending_count: 0, fel_bolag: [], bolag_choices: [post.bolag],
    } } })
  })
  await page.goto('/e/general/underlagsjakt')
  await page.getByRole('button', { name: messages.expand, exact: true }).click()
  return saves
}

async function chooseCategory(page, category) {
  await page.getByRole('combobox', { name: messages.field_kategori, exact: true }).click()
  await page.getByRole('option', { name: messages[`kategori_option_${category}`], exact: true }).click()
}

test('understandable categories, editable suggestions, and saving without BAS or VAT', async ({ page }) => {
  const saves = await openAnswer(page)
  const account = page.getByLabel('BAS-konto (valfritt)', { exact: true })
  await expect(account).toHaveValue('')
  await expect(page.getByRole('combobox', { name: 'Momstyp (valfritt)', exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: messages.field_kategori, exact: true }).click()
  for (const category of ['leverantor', 'utlagg', 'lon', 'intern_overforing', 'lan', 'ranta', 'skatt', 'bankavgift']) {
    await expect(page.getByRole('option', { name: messages[`kategori_option_${category}`], exact: true })).toBeVisible()
  }
  await page.getByRole('option', { name: messages.kategori_option_bankavgift, exact: true }).click()
  await expect(account).toHaveValue('6570')
  await expect(page.getByText(messages.field_bas_konto_suggestion, { exact: true })).toBeVisible()
  await chooseCategory(page, 'ranta')
  await expect(account).toHaveValue('8410')
  await account.fill('6540')
  await chooseCategory(page, 'bankavgift')
  await expect(account).toHaveValue('6540')
  await expect(page.getByText(messages.field_bas_konto_suggestion, { exact: true })).toHaveCount(0)
  await account.fill('')
  await chooseCategory(page, 'ranta')
  await expect(account).toHaveValue('')
  await page.getByRole('radio', { name: messages.candidate_none_needed, exact: true }).check()
  await page.getByRole('button', { name: messages.submit, exact: true }).click()
  await expect.poll(() => saves.length).toBe(1)
  expect(saves[0]).toMatchObject({ kategori: 'ranta', bas_konto: null, momstyp: null })
})

test('prefills an account for the category from the export', async ({ page }) => {
  await openAnswer(page, { kategori: 'bankavgift', bas_konto: null, momstyp: null, varfor: '' })
  await expect(page.getByLabel('BAS-konto (valfritt)', { exact: true })).toHaveValue('6570')
})

test('replaces an exported suggestion after category change', async ({ page }) => {
  await openAnswer(page, { kategori: 'bankavgift', bas_konto: '6540', momstyp: null, varfor: '' })
  await expect(page.getByLabel('BAS-konto (valfritt)', { exact: true })).toHaveValue('6540')
  await chooseCategory(page, 'ranta')
  await expect(page.getByLabel('BAS-konto (valfritt)', { exact: true })).toHaveValue('8410')
  await chooseCategory(page, 'bankavgift')
  await expect(page.getByLabel('BAS-konto (valfritt)', { exact: true })).toHaveValue('6570')
})


test('leaves salary accounts empty when the export has no entity type', async ({ page }) => {
  await openAnswer(page)
  await chooseCategory(page, 'lon')
  await expect(page.getByLabel('BAS-konto (valfritt)', { exact: true })).toHaveValue('')
  await expect(page.getByText(messages.field_bas_konto_suggestion, { exact: true })).toHaveCount(0)
})
