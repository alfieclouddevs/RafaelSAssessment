const NodeCache = require('node-cache');
const tokenCache = new NodeCache({ stdTTL: 3500 });

const disallowedValues = [
  '[not provided]',
  'placeholder',
  '[[unknown]]',
  'not set',
  'not provided',
  'unknown',
  'undefined',
  'n/a'
];

const createAction = (companyOrMeeting, actionTemplate, lastPulledDate) => {
  
  const isCreated = !lastPulledDate || (new Date(companyOrMeeting.createdAt) > lastPulledDate)

  return ({
    actionName: isCreated ? `${[companyOrMeeting]} Created` : `${[companyOrMeeting]} Updated`,
    actionDate: new Date(isCreated ? companyOrMeeting.createdAt : companyOrMeeting.updatedAt) - 2000,
    ...actionTemplate
  })
};

const createSearchFilter = (properties, lastModifiedDate, now) => {
  return {
    groups: [generateLastModifiedDateFilter(lastModifiedDate, now)],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
    properties,
    limit: 100
  }
}

const findHubspotAccount = (domain, hubId) => {
  return domain.integrations.hubspot.accounts.find(account => account.hubId === hubId);
}

const fetchDataWithRetry = async (type=null, hubspotClient, searchObj, expirationDate, domain, hubId) => {
  let searchResult = {};
  let tryCount = 0;

  while (tryCount <= 4) {
    try {
      searchResult = await hubspotClient.crm.objects.searchApi.doSearch(type, searchObj);
      return searchResult;
    } catch {
      tryCount++;
      if (new Date() > expirationDate) await refreshAccessToken(domain, hubId, hubspotClient);
      await new Promise(resolve => setTimeout(resolve, 5000 * Math.pow(2, tryCount)));
    }
  }

  throw new Error(`Failed to fetch ${type} after 4 attempts. Aborting.`);
}

const filterNullValuesFromObject = object =>
  Object
    .fromEntries(
      Object
        .entries(object)
        .filter(([_, v]) =>
          v !== null &&
          v !== '' &&
          typeof v !== 'undefined' &&
          (typeof v !== 'string' || !disallowedValues.includes(v.toLowerCase()) || !v.toLowerCase().includes('!$record'))));


const generateLastModifiedDateFilter = (date, nowDate, propertyName = 'hs_lastmodifieddate') => {
  const lastModifiedDateFilter = date ?
    {
      filters: [
        { propertyName, operator: 'GTE', value: `${date.valueOf()}` },
        { propertyName, operator: 'LTE', value: `${nowDate.valueOf()}` }
      ]
    } :
    {};

  return lastModifiedDateFilter;
}

const goal = actions => {
  // this is where the data will be written to the database
  console.log(actions);
};

const normalizePropertyName = key => key.toLowerCase().replace(/__c$/, '').replace(/^_+|_+$/g, '').replace(/_+/g, '_');

/**
 * Get access token from HubSpot
 */
const refreshAccessToken = async (domain, hubId, hubspotClient) => {
  console.log('refreshing access token')
  const { HUBSPOT_CID, HUBSPOT_CS } = process.env;
  const account = findHubspotAccount(domain, hubId);

  const cachedToken = tokenCache.get(`accessToken_${hubId}`);
  console.log('token cached')
  if (cachedToken) {
    console.log('Using cached access token');
    hubspotClient.setAccessToken(cachedToken);
    return true;
  }

  const { refreshToken } = account;
  const result = await hubspotClient.oauth.tokensApi.createToken(
    'refresh_token', undefined, undefined, HUBSPOT_CID, HUBSPOT_CS, refreshToken
  );
  console.log('refreshed token')
  const newAccessToken = result.accessToken;
  expirationDate = new Date(result.expiresIn * 1000 + Date.now());

  tokenCache.set(`accessToken_${hubId}`, newAccessToken);
  // console.log('set access token cache', tokenCache)

  hubspotClient.setAccessToken(newAccessToken);

  account.accessToken = newAccessToken;
  return true;
};

const saveDomain = async domain => {
  // disable this for testing purposes
  return;

  domain.markModified('integrations.hubspot.accounts');
  await domain.save();
};


const safeExecute = async (operationName, fn, metadata = {}) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`Error in operation: ${operationName}`, { error: err.message, metadata });
    throw err;
  }
};

const updatePaginationState = (offsetObject, data, maxOffset = 9900) => {
  if (!offsetObject?.after) {
    return false; 
  }

  if (offsetObject?.after >= maxOffset) {
    offsetObject.after = 0; 
    offsetObject.lastModifiedDate = new Date(data[data.length - 1].updatedAt).valueOf();
  }

  return true; 
}

module.exports = {
  createAction,
  createSearchFilter,
  fetchDataWithRetry,
  filterNullValuesFromObject,
  findHubspotAccount,
  generateLastModifiedDateFilter,
  normalizePropertyName,
  goal,
  refreshAccessToken,
  saveDomain,
  safeExecute,
  updatePaginationState
};
