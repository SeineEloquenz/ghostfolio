import { ghostfolioPrefix } from '@ghostfolio/common/config';
import {
  CreateAssetProfileWithMarketDataDto,
  CreateOrderDto
} from '@ghostfolio/common/dtos';
import { Activity } from '@ghostfolio/common/interfaces';
import type { Account } from '@ghostfolio/prisma/browser';
import {
  AssetClass,
  AssetSubClass,
  DataSource,
  Type as ActivityType
} from '@ghostfolio/prisma/enums';

import { Big } from 'big.js';
import { findLastIndex, isDate, isFinite, isNumber, isString } from 'lodash-es';
import ms from 'ms';
import { parse as csvToJson } from 'papaparse';

const ACCOUNT_NAME = 'Trade Republic';

const ACTIVITY_TYPES: Record<string, ActivityType> = {
  BUY: 'BUY',
  DISTRIBUTION: 'DIVIDEND',
  DIVIDEND: 'DIVIDEND',
  INTEREST_PAYMENT: 'INTEREST',
  SELL: 'SELL'
};

// Bonds are quoted in percent of the nominal value, so they are held in units of 100
const NOMINAL_UNIT = 100;

const ASSET_CLASSES: Record<
  string,
  { assetClass: AssetClass; assetSubClass: AssetSubClass }
> = {
  BOND: {
    assetClass: AssetClass.FIXED_INCOME,
    assetSubClass: AssetSubClass.BOND
  },
  FUND: { assetClass: AssetClass.EQUITY, assetSubClass: AssetSubClass.ETF },
  STOCK: { assetClass: AssetClass.EQUITY, assetSubClass: AssetSubClass.STOCK }
};

const REQUIRED_FIELDS = [
  'account_type',
  'amount',
  'asset_class',
  'datetime',
  'shares',
  'symbol',
  'transaction_id',
  'type'
];

export function isTradeRepublicCsv(fileContent: string) {
  const { fields = [] } = csvToJson(fileContent, {
    header: true,
    preview: 1
  }).meta;

  return REQUIRED_FIELDS.every((field) => {
    return fields.includes(field);
  });
}

/**
 * Converts a Trade Republic transaction export into activities and custom
 * asset profiles. Rows other than trades and dividends are skipped.
 */
export function convertTradeRepublicCsv({
  fileContent,
  userAccounts
}: {
  fileContent: string;
  userAccounts: Account[];
}) {
  const rows = csvToJson<Record<string, unknown>>(fileContent, {
    dynamicTyping: true,
    header: true,
    skipEmptyLines: true
  }).data;

  const accountId = userAccounts.find(({ name }) => {
    return name?.toLowerCase() === ACCOUNT_NAME.toLowerCase();
  })?.id;

  const activities: CreateOrderDto[] = [];
  const assetProfiles = new Map<string, CreateAssetProfileWithMarketDataDto>();

  for (const row of rows) {
    const type = ACTIVITY_TYPES[toString(row.type)];
    const isin = toString(row.symbol);
    const amount = toNumber(row.amount);
    const symbol = `${ghostfolioPrefix}_${isin}`;

    if (type === 'INTEREST' && amount < 0) {
      const reversedIndex = findLastIndex(activities, (activity) => {
        return (
          activity.symbol === symbol &&
          activity.type === 'INTEREST' &&
          Math.abs(activity.unitPrice + amount) < 0.005
        );
      });

      if (reversedIndex >= 0) {
        activities.splice(reversedIndex, 1);
      }

      continue;
    }

    const unit =
      toString(row.asset_class) === 'BOND' && type !== 'INTEREST'
        ? NOMINAL_UNIT
        : 1;
    const quantity =
      type === 'INTEREST'
        ? 1
        : new Big(Math.abs(toNumber(row.shares))).div(unit).toNumber();

    if (!type || !isin || !quantity) {
      continue;
    }

    const currency = toString(row.currency) || 'EUR';

    // Dividend and interest rows only contain the total amount
    const unitPrice =
      type === 'DIVIDEND' || type === 'INTEREST' || !toNumber(row.price)
        ? Math.abs(amount) / quantity
        : new Big(toNumber(row.price)).times(unit).toNumber();

    activities.push({
      accountId,
      currency,
      quantity,
      symbol,
      type,
      unitPrice,
      comment: toString(row.transaction_id),
      dataSource: DataSource.MANUAL,
      date: toDate(row.datetime).toISOString(),
      fee: Math.abs(toNumber(row.fee)),
      updateAccountBalance: false
    });

    if (!assetProfiles.has(symbol)) {
      assetProfiles.set(symbol, {
        currency,
        isin,
        symbol,
        assetClass: ASSET_CLASSES[toString(row.asset_class)]?.assetClass,
        assetSubClass: ASSET_CLASSES[toString(row.asset_class)]?.assetSubClass,
        countries: [],
        dataSource: DataSource.MANUAL,
        holdings: [],
        isActive: true,
        marketData: [],
        name: toString(row.name) || isin,
        scraperConfiguration: getScraperConfiguration({
          isin,
          assetClass: toString(row.asset_class)
        }),
        sectors: []
      });
    }
  }

  return { activities, assetProfiles: [...assetProfiles.values()] };
}

/**
 * Marks activities as duplicates if they match an existing activity, including
 * those imported with day-only dates, rounded prices and dividends with the
 * total amount as unit price. Activities of instruments without existing
 * activities are skipped if they predate the latest duplicate.
 */
export function reconcileTradeRepublicActivities({
  activities,
  convertedActivities,
  existingActivities
}: {
  activities: Activity[];
  convertedActivities: CreateOrderDto[];
  existingActivities: Activity[];
}): Activity[] {
  // The dry run can replace the symbol of an asset profile owned by another user
  const convertedSymbols = new Map(
    convertedActivities.map(({ comment, symbol }) => {
      return [comment, symbol];
    })
  );

  const trackedSymbols = new Set(
    existingActivities.map(({ assetProfile }) => {
      return assetProfile?.symbol;
    })
  );

  const getSymbols = ({ assetProfile, comment }: Activity) => {
    return [assetProfile?.symbol, convertedSymbols.get(comment ?? undefined)];
  };

  let latestDuplicateDate = -Infinity;

  return activities
    .map((activity) => {
      const symbols = getSymbols(activity);

      const duplicate = existingActivities.find((existingActivity) => {
        return (
          symbols.includes(existingActivity.assetProfile?.symbol) &&
          isSameTradeRepublicActivity(existingActivity, activity)
        );
      });

      if (!duplicate) {
        return activity;
      }

      latestDuplicateDate = Math.max(
        latestDuplicateDate,
        toDate(duplicate.date).getTime()
      );

      return { ...activity, error: { code: 'IS_DUPLICATE' as const } };
    })
    .filter((activity) => {
      return (
        Boolean(activity.error) ||
        getSymbols(activity).some((symbol) => {
          return symbol && trackedSymbols.has(symbol);
        }) ||
        toDate(activity.date).getTime() > latestDuplicateDate
      );
    });
}

// Bonds are not traded on Xetra, their price per 100 nominal matches NOMINAL_UNIT
function getScraperConfiguration({
  assetClass,
  isin
}: {
  assetClass: string;
  isin: string;
}) {
  const mic = assetClass === 'BOND' ? 'XFRA' : 'XETR';

  return {
    mode: 'lazy',
    selector: '$.lastPrice',
    url: `https://api.boerse-frankfurt.de/v1/data/quote_box/single?isin=${isin}&mic=${mic}`
  };
}

function isSameTradeRepublicActivity(existing: Activity, activity: Activity) {
  if (
    existing.type !== activity.type ||
    Math.abs(existing.quantity - activity.quantity) >
      1e-6 * Math.max(1, activity.quantity)
  ) {
    return false;
  }

  const date = toDate(activity.date);
  const existingDate = toDate(existing.date);

  const startOfDay = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );

  // Day-only dates were stored as midnight in the timezone of the browser
  const isDayOnly =
    existingDate.getTime() % ms('15 minutes') === 0 &&
    Math.abs(existingDate.getTime() - startOfDay) <= ms('14 hours');

  if (Math.abs(existingDate.getTime() - date.getTime()) >= 1000 && !isDayOnly) {
    return false;
  }

  const value = activity.quantity * activity.unitPrice;
  const existingValue = existing.quantity * existing.unitPrice;

  return (
    Math.abs(existingValue - value) <= Math.max(0.01, 0.01 * value) ||
    (activity.type === 'DIVIDEND' &&
      Math.abs(existing.unitPrice - value) < 0.01)
  );
}

function toDate(value: unknown) {
  return isDate(value) ? value : new Date(toString(value));
}

function toNumber(value: unknown) {
  return isNumber(value) && isFinite(value) ? value : 0;
}

function toString(value: unknown) {
  return isString(value) ? value.trim() : '';
}
