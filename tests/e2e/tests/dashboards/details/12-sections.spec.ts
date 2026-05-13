import type { Page } from '@playwright/test';

import { expect, test } from '../../../fixtures/auth';
import { newAdminContext } from '../../../helpers/auth';
import {
	authToken,
	createApmMetricsDashboardViaApi,
	deleteDashboardViaApi,
} from '../../../helpers/dashboards';

// Tests in this file mutate section state on a single APM Metrics seed
// (collapse / rename / add / remove). Run them serially within the worker so
// state from one test does not leak into the next.
test.describe.configure({ mode: 'serial' });

// ─── Suite-level seed registry ───────────────────────────────────────────
//
// One APM Metrics dashboard powers every TC in this file (4 sections, 16
// panels — including the duplicate-named "Overview" sections, which the
// fixture intentionally ships). A single `afterAll` deletes every dashboard
// the suite touched.
const seedIds = new Set<string>();
let apmDashboardId: string;

test.beforeAll(async ({ browser }) => {
	const ctx = await newAdminContext(browser);
	const page = await ctx.newPage();
	try {
		apmDashboardId = await createApmMetricsDashboardViaApi(page);
		seedIds.add(apmDashboardId);
	} finally {
		await ctx.close();
	}
});

test.afterAll(async ({ browser }) => {
	if (seedIds.size === 0) {
		return;
	}
	const ctx = await newAdminContext(browser);
	const page = await ctx.newPage();
	try {
		const token = await authToken(page);
		for (const id of seedIds) {
			await deleteDashboardViaApi(ctx.request, id, token);
			seedIds.delete(id);
		}
	} finally {
		await ctx.close();
	}
});


/**
 * Resolve the `.row-panel` container for a section by traversing up from its
 * title text. The fixture ships two sections both literally named "Overview"
 * — pass `index` to disambiguate. Two `..` hops reach `.row-panel`, which
 * holds both the chevron and the settings-icon for that row.
 */
function sectionRow(
	page: Page,
	name: string | RegExp,
	index = 0,
): ReturnType<Page['locator']> {
	return page
		.getByText(name, { exact: typeof name === 'string' })
		.nth(index)
		.locator('..')
		.locator('..');
}

async function gotoApmDashboard(page: Page): Promise<void> {
	await page.goto(`/dashboard/${apmDashboardId}`);
	await page
		.getByRole('button', { name: /dashboard-icon APM Metrics/ })
		.waitFor({ state: 'visible' });
}

test.describe('Dashboard Detail — Sections', () => {
	// ─── Collapse / expand chevron and widget-count suffix ───────────────────

	test('TC-01 collapsing a section hides panels and shows widget count', async ({
		authedPage: page,
	}) => {
		await gotoApmDashboard(page);

		await sectionRow(page, 'DB Metrics').locator('.lucide-chevron-up').click();

		// After collapse the section title is rewritten to include the count
		// suffix; assert with a regex so the test is robust to widget-count
		// drift in the fixture.
		await expect(
			page.getByText(/^DB Metrics \(\d+ widgets?\)$/).first(),
		).toBeVisible();

		// Restore: chevron-down is the row-icon variant rendered for collapsed
		// sections. Re-resolve via the new (suffixed) title.
		await sectionRow(page, /^DB Metrics \(\d+ widgets?\)$/)
			.locator('.lucide-chevron-down.row-icon')
			.click();
		await expect(
			page.getByText(/^DB Metrics \(\d+ widgets?\)$/),
		).toHaveCount(0);
	});

	test('TC-02 widget count matches number of panels visible before collapse', async ({
		authedPage: page,
	}) => {
		await gotoApmDashboard(page);

		// The first Overview section in the APM fixture holds these four
		// panels — they're our ground truth for the count assertion below.
		await expect(page.getByText('Latency', { exact: true }).first()).toBeVisible();
		await expect(
			page.getByText('Request rate', { exact: true }).first(),
		).toBeVisible();
		await expect(
			page.getByText('Error percentage', { exact: true }).first(),
		).toBeVisible();
		await expect(
			page.getByText('Top operations', { exact: true }).first(),
		).toBeVisible();

		await sectionRow(page, 'Overview', 0).locator('.lucide-chevron-up').click();

		await expect(
			page.getByText('Overview (4 widgets)', { exact: true }).first(),
		).toBeVisible();

		// Restore.
		await sectionRow(page, 'Overview (4 widgets)')
			.locator('.lucide-chevron-down.row-icon')
			.click();
		await expect(
			page.getByText('Overview (4 widgets)', { exact: true }),
		).toHaveCount(0);
	});

	test('TC-03 expanding restores panels', async ({ authedPage: page }) => {
		await gotoApmDashboard(page);

		// Collapse "DB Metrics" instead of the first Overview — its widgets
		// have unique titles ("DB Calls RPS" / "Database Calls Avg Duration")
		// so collapse/expand transitions can be asserted without colliding
		// with the duplicate-titled panels in the two Overview sections.
		// "DB Metrics" lives further down the canvas; scroll into view first
		// so the panels actually mount (the canvas virtualises off-screen).
		const dbCalls = page.getByText('DB Calls RPS', { exact: true }).first();
		await dbCalls.scrollIntoViewIfNeeded();
		await expect(dbCalls).toBeVisible({ timeout: 15_000 });
		await sectionRow(page, 'DB Metrics').locator('.lucide-chevron-up').click();
		await expect(
			page.getByText(/^DB Metrics \(\d+ widgets?\)$/).first(),
		).toBeVisible();

		// While collapsed, "DB Calls RPS" should fully unmount.
		await expect(page.getByText('DB Calls RPS', { exact: true })).toHaveCount(
			0,
		);

		await sectionRow(page, /^DB Metrics \(\d+ widgets?\)$/)
			.locator('.lucide-chevron-down.row-icon')
			.click();

		await expect(
			page.getByText('DB Calls RPS', { exact: true }).first(),
		).toBeVisible();
		await expect(
			page.getByText(/^DB Metrics \(\d+ widgets?\)$/),
		).toHaveCount(0);
	});

	// ─── Section options menu (Rename / New Panel / Remove Section) ──────────

	test('TC-04 section options menu shows Rename / New Panel / Remove Section', async ({
		authedPage: page,
	}) => {
		await gotoApmDashboard(page);

		// Use DB Metrics — its settings popover is guaranteed to render all
		// three buttons when the section is expanded. WidgetRow.tsx hides
		// "Remove Section" while a section is collapsed.
		await sectionRow(page, 'DB Metrics').locator('.settings-icon').click();

		const tooltip = page.getByRole('tooltip');
		await expect(tooltip).toBeVisible();
		await expect(tooltip.getByRole('button', { name: 'Rename' })).toBeVisible();
		await expect(
			tooltip.getByRole('button', { name: 'New Panel', exact: true }),
		).toBeVisible();
		await expect(
			tooltip.getByRole('button', { name: 'Remove Section' }),
		).toBeVisible();

		await page.keyboard.press('Escape');
	});

	test('TC-05 rename a section, restore original name', async ({
		authedPage: page,
	}) => {
		await gotoApmDashboard(page);

		const renamed = `Renamed Section ${Date.now()}`;

		// DB Metrics has a unique name, avoiding the duplicate-Overview snag.
		await sectionRow(page, 'DB Metrics').locator('.settings-icon').click();
		await page
			.getByRole('tooltip')
			.getByRole('button', { name: 'Rename' })
			.click();

		const renameDialog = page.getByRole('dialog', { name: 'Rename Section' });
		await expect(renameDialog).toBeVisible();
		const nameInput = renameDialog.getByPlaceholder('Enter row name here...');
		await nameInput.click();
		await nameInput.fill(renamed);
		await renameDialog.getByRole('button', { name: 'Apply Changes' }).click();
		await expect(renameDialog).not.toBeVisible();

		await expect(page.getByText(renamed, { exact: true }).first()).toBeVisible();

		// Restore.
		await sectionRow(page, renamed).locator('.settings-icon').click();
		await page
			.getByRole('tooltip')
			.getByRole('button', { name: 'Rename' })
			.click();
		const restoreDialog = page.getByRole('dialog', { name: 'Rename Section' });
		const restoreInput = restoreDialog.getByPlaceholder(
			'Enter row name here...',
		);
		await restoreInput.click();
		await restoreInput.fill('DB Metrics');
		await restoreDialog.getByRole('button', { name: 'Apply Changes' }).click();
		await expect(restoreDialog).not.toBeVisible();

		await expect(
			page.getByText('DB Metrics', { exact: true }).first(),
		).toBeVisible();
		await expect(page.getByText(renamed, { exact: true })).toHaveCount(0);
	});

	test('TC-06 cancel section rename leaves name unchanged', async ({
		authedPage: page,
	}) => {
		await gotoApmDashboard(page);

		await sectionRow(page, 'External calls').locator('.settings-icon').click();
		await page
			.getByRole('tooltip')
			.getByRole('button', { name: 'Rename' })
			.click();

		const dialog = page.getByRole('dialog', { name: 'Rename Section' });
		await expect(dialog).toBeVisible();
		const input = dialog.getByPlaceholder('Enter row name here...');
		await input.click();
		await input.fill('Should Not Be Applied');

		await dialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(dialog).not.toBeVisible();

		await expect(
			page.getByText('External calls', { exact: true }).first(),
		).toBeVisible();
		await expect(page.getByText('Should Not Be Applied')).toHaveCount(0);
	});

	test('TC-07 add a new panel to a section, then delete it', async ({
		authedPage: page,
	}) => {
		await gotoApmDashboard(page);

		const panelName = `Test Panel ${Date.now()}`;

		await sectionRow(page, 'DB Metrics').locator('.settings-icon').click();
		await page
			.getByRole('tooltip')
			.getByRole('button', { name: 'New Panel', exact: true })
			.click();

		const panelTypeDialog = page.getByRole('dialog', { name: 'New Panel' });
		await expect(panelTypeDialog).toBeVisible();
		await panelTypeDialog.getByTestId('panel-type-graph').click();

		// We're now in the panel editor at /dashboard/:id/new?widgetId=…
		await page.waitForURL(/\/new/);
		await expect(page.getByTestId('new-widget-save')).toBeVisible();

		await page.getByTestId('panel-name-input').fill(panelName);

		await page.getByTestId('new-widget-save').click();
		const saveDialog = page.getByRole('dialog', { name: 'Save Widget' });
		await expect(saveDialog).toBeVisible();

		// PUT confirms the panel persisted server-side — more reliable than
		// waiting on redux state to propagate before navigating back.
		const putResponse = page.waitForResponse(
			(r) => r.request().method() === 'PUT' && /\/dashboards\//.test(r.url()),
		);
		await saveDialog.getByRole('button', { name: 'OK' }).click();
		await putResponse;

		await page.waitForURL((url) => !url.pathname.includes('/new'));
		await expect(page.getByText(panelName, { exact: true }).first()).toBeVisible();


		// Cleanup: open the new panel's ⋮ menu and delete via the confirm
		// dialog. The PUT-on-OK pattern again ensures the canvas has settled
		// before the test ends.
		const panelTitle = page.getByText(panelName, { exact: true }).first();
		await panelTitle.hover();
		const panelContainer = panelTitle.locator('../..');
		await panelContainer.getByTestId('widget-header-options').click();
		await page.getByRole('menuitem', { name: 'delete Delete' }).click();

		const deleteDialog = page.getByRole('dialog', { name: 'Delete' });
		await expect(deleteDialog).toBeVisible();

		const deletePut = page.waitForResponse(
			(r) => r.request().method() === 'PUT' && /\/dashboards\//.test(r.url()),
		);
		await deleteDialog.getByRole('button', { name: 'OK' }).click();
		await deletePut;
		await expect(deleteDialog).not.toBeVisible();
		await expect(page.getByText(panelName, { exact: true })).toHaveCount(0);
	});

	// ─── New section in edit mode ────────────────────────────────────────────

	test('TC-08 add a new section via edit mode, then remove it', async ({
		authedPage: page,
	}) => {
		await gotoApmDashboard(page);

		const sectionName = `Temp Section ${Date.now()}`;

		// Enter edit mode via the toolbar options popup. The "New section"
		// button only appears once edit mode is unlocked.
		await page.getByTestId('options').click();
		await page.getByRole('button', { name: 'New section' }).click();

		const newSectionDialog = page.getByRole('dialog', { name: 'New Section' });
		await expect(newSectionDialog).toBeVisible();
		await newSectionDialog.getByTestId('section-name').fill(sectionName);
		await newSectionDialog
			.getByRole('button', { name: 'Create Section' })
			.click();
		await expect(newSectionDialog).not.toBeVisible();

		await expect(
			page.getByText(sectionName, { exact: true }).first(),
		).toBeVisible();

		// Remove the section via its options menu. "Delete Row" is the
		// admin-only confirm dialog; verify the title before clicking OK so
		// the test fails loudly if the dialog name regresses.
		await sectionRow(page, sectionName).locator('.settings-icon').click();
		await page
			.getByRole('tooltip')
			.getByRole('button', { name: 'Remove Section' })
			.click();

		const deleteRowDialog = page.getByRole('dialog', { name: 'Delete Row' });
		await expect(deleteRowDialog).toBeVisible();
		await deleteRowDialog.getByRole('button', { name: 'OK' }).click();
		await expect(deleteRowDialog).not.toBeVisible();

		await expect(page.getByText(sectionName, { exact: true })).toHaveCount(0);

		// Original sections are untouched.
		await expect(
			page.getByText('Overview', { exact: true }).first(),
		).toBeVisible();
		await expect(
			page.getByText('DB Metrics', { exact: true }).first(),
		).toBeVisible();
		await expect(
			page.getByText('External calls', { exact: true }).first(),
		).toBeVisible();
	});

	// ─── Deep coverage ───────────────────────────────────────────────────────

	test('TC-09 collapsing two sections in sequence shows both as collapsed', async ({
		authedPage: page,
	}) => {
		await gotoApmDashboard(page);

		await sectionRow(page, 'DB Metrics').locator('.lucide-chevron-up').click();
		await expect(
			page.getByText(/^DB Metrics \(\d+ widgets?\)$/).first(),
		).toBeVisible();

		await sectionRow(page, 'External calls')
			.locator('.lucide-chevron-up')
			.click();
		await expect(
			page.getByText(/^External calls \(\d+ widgets?\)$/).first(),
		).toBeVisible();

		// Restore both so the test leaves no state behind.
		await sectionRow(page, /^DB Metrics \(\d+ widgets?\)$/)
			.locator('.lucide-chevron-down.row-icon')
			.click();
		await sectionRow(page, /^External calls \(\d+ widgets?\)$/)
			.locator('.lucide-chevron-down.row-icon')
			.click();
		await expect(
			page.getByText(/^DB Metrics \(\d+ widgets?\)$/),
		).toHaveCount(0);
		await expect(
			page.getByText(/^External calls \(\d+ widgets?\)$/),
		).toHaveCount(0);
	});

	test('TC-10 panels inside a collapsed section are not in the DOM', async ({
		authedPage: page,
	}) => {
		await gotoApmDashboard(page);

		// "DB Calls RPS" is a unique panel inside the "DB Metrics" section.
		const dbPanel = page.getByText('DB Calls RPS', { exact: true });
		await dbPanel.first().scrollIntoViewIfNeeded();
		await expect(dbPanel.first()).toBeVisible();

		await sectionRow(page, 'DB Metrics').locator('.lucide-chevron-up').click();
		await expect(
			page.getByText(/^DB Metrics \(\d+ widgets?\)$/).first(),
		).toBeVisible();

		// Panels inside the collapsed section unmount, not just hidden.
		await expect(dbPanel).toHaveCount(0);

		// Restore.
		await sectionRow(page, /^DB Metrics \(\d+ widgets?\)$/)
			.locator('.lucide-chevron-down.row-icon')
			.click();
		await expect(dbPanel.first()).toBeVisible();
	});
});
