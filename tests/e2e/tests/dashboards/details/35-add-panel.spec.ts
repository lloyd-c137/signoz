import { expect, test } from '../../../fixtures/auth';
import { newAdminContext } from '../../../helpers/auth';
import {
	authToken,
	createDashboardViaApi,
	deleteDashboardViaApi,
} from '../../../helpers/dashboards';

// Scope: dashboard-side seams only —
//   1. The toolbar "New Panel" button opens a dialog listing every panel type
//      the app supports (the dashboard's responsibility).
//   2. A panel created from the dialog actually lands on the canvas and
//      survives a hard reload (the dashboard's persistence contract).
//
// Editor-internal behaviour (Query Builder vs ClickHouse tab, Panel Settings,
// y-axis units, panel-type changes, etc.) belongs in a separate panel-editor
// spec — do NOT add those here.

test.describe.configure({ mode: 'serial' });

const seedIds = new Set<string>();

test.afterAll(async ({ browser }) => {
	if (seedIds.size === 0) return;
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

test.describe('Dashboard Detail — Add Panel (entry-point + persistence)', () => {
	test('TC-01 New Panel toolbar button opens a dialog listing all 7 panel types', async ({
		authedPage: page,
	}) => {
		const ts = Date.now();
		const id = await createDashboardViaApi(page, `add-panel-dialog-${ts}`);
		seedIds.add(id);

		await page.goto(`/dashboard/${id}`);
		// Empty dashboards render an onboarding canvas with a duplicate
		// `add-panel-header` CTA. Scope to the toolbar (`.right-section`).
		await page
			.locator('.dashboard-details .right-section')
			.getByTestId('add-panel-header')
			.click();

		const dialog = page.getByRole('dialog', { name: 'New Panel' });
		await expect(dialog).toBeVisible();

		for (const tile of [
			'panel-type-graph',
			'panel-type-value',
			'panel-type-table',
			'panel-type-list',
			'panel-type-bar',
			'panel-type-pie',
			'panel-type-histogram',
		]) {
			await expect(dialog.getByTestId(tile)).toBeVisible();
		}

		// Dialog dismisses via the Close (×) button — confirms the user can
		// back out without entering the editor (no /new navigation happens
		// until a tile is picked).
		await dialog.getByRole('button', { name: 'Close' }).click();
		await expect(dialog).toBeHidden();
		await expect(page).not.toHaveURL(/\/new/);
	});

	test('TC-02 saving a new panel persists it on the canvas across reload', async ({
		authedPage: page,
	}) => {
		const ts = Date.now();
		const id = await createDashboardViaApi(page, `add-panel-persist-${ts}`);
		seedIds.add(id);
		const panelName = `e2e-panel-${ts}`;

		await page.goto(`/dashboard/${id}`);
		await page
			.locator('.dashboard-details .right-section')
			.getByTestId('add-panel-header')
			.click();
		await page
			.getByRole('dialog', { name: 'New Panel' })
			.getByTestId('panel-type-graph')
			.click();

		// We're now on the editor; minimal interaction — set the name and save.
		// Anything else (queries, panel-type changes, units) is editor-internal
		// and belongs in a panel-editor spec.
		await expect(page.getByTestId('new-widget-save')).toBeVisible();
		await page.getByTestId('panel-name-input').fill(panelName);

		const savePut = page.waitForResponse(
			(r) => r.request().method() === 'PUT' && /\/dashboards\//.test(r.url()),
		);
		await page.getByTestId('new-widget-save').click();
		await page
			.getByRole('dialog', { name: 'Save Widget' })
			.getByRole('button', { name: 'OK' })
			.click();
		const putResp = await savePut;
		expect(putResp.ok()).toBeTruthy();

		// Back on the dashboard — the new panel must render with the typed name.
		await expect(page).not.toHaveURL(/\/new/);
		await expect(
			page.getByText(panelName, { exact: true }).first(),
		).toBeVisible();

		// Persistence — hard reload, panel still there.
		await page.reload();
		await expect(
			page.getByText(panelName, { exact: true }).first(),
		).toBeVisible();
	});
});
