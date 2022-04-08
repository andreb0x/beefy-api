const axios = require('axios');
const BigNumber = require('bignumber.js');

const fetchPrice = require('../../../../utils/fetchPrice');

const ICurveGauge = require('../../../../abis/ICurveGauge.json');
const IRewardStream = require('../../../../abis/ICurveRewardStream.json');
const ICurveRewards = require('../../../../abis/ICurveRewards.json');

const secondsPerYear = 31536000;

const getCurveBaseApys = async (pools, url, factoryUrl) => {
  let factoryApyData = [];
  if (factoryUrl) {
    try {
      const response = await axios.get(factoryUrl);
      factoryApyData = response.data.data.poolDetails;
    } catch (e) {
      console.error('Curve factory apy error ', factoryUrl, e);
    }
  }

  let apys = {};
  try {
    const response = await axios.get(url);
    const apyData = response.data.apy;
    pools.forEach(pool => {
      let apy;
      if (pool.baseApyKey) {
        apy = new BigNumber(getBaseApy(apyData, pool));
      } else {
        apy = new BigNumber(getFactoryApy(factoryApyData, pool.pool));
      }
      apys = { ...apys, ...{ [pool.name]: apy } };
    });
  } catch (err) {
    console.error('Curve base apy error ', url, err);
  }
  return apys;
};

const getBaseApy = (baseApyData, pool) => {
  try {
    return Math.max(
      baseApyData.day[pool.baseApyKey],
      baseApyData.week[pool.baseApyKey],
      baseApyData.month[pool.baseApyKey],
      baseApyData.total[pool.baseApyKey]
    );
  } catch (err) {
    console.error(err);
    return 0;
  }
};

const getFactoryApy = (factoryApyData, poolAddress) => {
  try {
    let pool = factoryApyData.find(p => p.poolAddress.toLowerCase() === poolAddress.toLowerCase());
    return pool ? Number(pool.apy) / 100 : 0;
  } catch (err) {
    console.error(err);
    return 0;
  }
};

// used outside of Curve farms - Spell, MAI, Jarvis
const getCurveFactoryApy = async (address, url) => {
  let apys = {};
  try {
    const response = await axios.get(url);
    const pools = response.data.data.poolDetails;
    pools.forEach(pool => {
      if (pool.poolAddress.toLowerCase() === address.toLowerCase()) {
        const apy = new BigNumber(pool.apy).dividedBy(100);
        apys = { ...apys, ...{ [address.toLowerCase()]: apy } };
      }
    });
  } catch (err) {
    console.error(err);
  }
  return apys;
};

const getTotalStakedInUsd = async (web3, pool) => {
  if (!pool.gauge) return new BigNumber(1);
  const gauge = new web3.eth.Contract(ICurveGauge, pool.gauge);
  let totalSupply;
  if (pool.boosted) {
    totalSupply = new BigNumber(await gauge.methods.working_supply().call());
  } else {
    totalSupply = new BigNumber(await gauge.methods.totalSupply().call());
  }
  const lpPrice = await fetchPrice({ oracle: 'lps', id: pool.name });
  return totalSupply.multipliedBy(lpPrice).dividedBy('1e18');
};

const getBoostedYearlyRewardsInUsd = async (web3, pool) => {
  const crvPrice = await fetchPrice({ oracle: 'tokens', id: 'CRV' });

  const gauge = new web3.eth.Contract(ICurveGauge, pool.gauge);
  const weekEpoch = Math.floor(Date.now() / 1000 / (86400 * 7));
  const rewardRate = new BigNumber(await gauge.methods.inflation_rate(weekEpoch).call());

  return rewardRate.times(secondsPerYear).times(0.4).times(crvPrice).dividedBy('1e18');
};

const getYearlyRewardsInUsd = async (web3, pool) => {
  if (pool.boosted) return getBoostedYearlyRewardsInUsd(web3, pool);

  let yearlyRewardsInUsd = new BigNumber(0);

  for (const rewards of pool.rewards) {
    let periodFinish, rewardRate;
    if (rewards.token) {
      const rewardStream = new web3.eth.Contract(ICurveRewards, rewards.stream);
      let { period_finish, rate } = await rewardStream.methods.reward_data(rewards.token).call();
      periodFinish = Number(period_finish);
      rewardRate = new BigNumber(rate);
    } else {
      const rewardStream = new web3.eth.Contract(IRewardStream, rewards.stream);
      periodFinish = Number(await rewardStream.methods.period_finish().call());
      rewardRate = new BigNumber(await rewardStream.methods.reward_rate().call());
    }

    if (periodFinish < Date.now() / 1000) {
      continue;
    }

    const price = await fetchPrice({ oracle: rewards.oracle ?? 'tokens', id: rewards.oracleId });
    const rewardsInUsd = rewardRate
      .times(secondsPerYear)
      .times(price)
      .dividedBy(rewards.decimals ?? '1e18');
    yearlyRewardsInUsd = yearlyRewardsInUsd.plus(rewardsInUsd);
  }

  return yearlyRewardsInUsd;
};

module.exports = {
  getCurveBaseApys,
  getCurveFactoryApy,
  getTotalStakedInUsd,
  getYearlyRewardsInUsd,
};
