'use strict';

const { google } = require('googleapis');
const analyticsreporting = google.analyticsreporting('v4');
const constants = require('../constants');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const analyticsDataClient = new BetaAnalyticsDataClient();
const propertyId = constants.DEFAULT_GA_VIEW;

module.exports = {
  batchGet: batchGet,
  userActivity: userActivity
};

async function batchGet(req, res) {
  try {

    const reportRequests = req.body.map(requestReport => {
      

      const report = {
        property: `properties/${propertyId}`, 
        dateRanges: [
          {
            startDate: requestReport.startDate,
            endDate: requestReport.endDate
          }
        ],
      
        metrics: [
          {
            name: requestReport.metric 
          }
        ],
        dimensions: [
          {
            name: requestReport.dimension 
          },
          { name: 'customEvent:event_s' }, 
        ],
        orderBys: [
          {
            metric: {
              metricName: requestReport.metric 
            },
            desc: true
          }
        ],
        dimensionFilter: {
          andGroup: {
            expressions: [
              {
                filter:
                  {fieldName: 'customEvent:event_s',
                  stringFilter: {
                    matchType: 'EXACT',
                    value: requestReport.clientId 
                  }
              }
              }
            ]
          }
        }
      };

      
      if (requestReport.filter) {
        report.dimensionFilter.andGroup.expressions.push({filter:{
          fieldName: requestReport.filter.name,
          stringFilter: {
            matchType: 'EXACT',
            value: requestReport.filter.value
          }
        }});
      }

      
      return report;
    });

    
    const reportPromises = reportRequests.map(async (request) => {
      return analyticsDataClient.runReport({
        property: request.property,
        dateRanges: request.dateRanges,
        dimensions: request.dimensions,
        metrics: request.metrics,
        orderBys: request.orderBys,
        dimensionFilter: request.dimensionFilter,
        limit: 1000 
      });
    });

    
    const reports = await Promise.all(reportPromises);

   
    res.status(200).json({
      message: 'Reports generated successfully',
      reports: reports.map(report => report[0]) 
    });
    
  } catch (err) {
    
    return res.status(409).json({
      message: 'Error getting analytics',
      error: err.message,
      errdet: { ...err }
    });
  }
}

async function userActivity(req, res) {
  try {
    //TODO: Implement user activity logic
    return res.status(200).json({});
  } catch (err) {
    return res.status(409).json({
      message: 'Error getting analytics',
      error: err.message
    });
  }
}