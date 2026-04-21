const express = require('express');
const { ObjectId } = require('mongodb');
const { getAdminActorFromRequest } = require('./admin-actor');

module.exports = ({ storeLocationStorage, auditLogger, getUserInfoFromRequest, toolAnalyticsStorage }) => {
  const router = express.Router();
  router.get('/admin/store-locations', async (req, res) => {
    try {
      const { page = 1, limit = 10, search, retailer, state, suburb } = req.query;
      const skip = (Number.parseInt(page) - 1) * Number.parseInt(limit);
      const searchQuery = {};
      if (search && search.trim()) {
        const searchTerm = search.trim();
        searchQuery.$or = [
          { store_name: { $regex: searchTerm, $options: 'i' } },
          { retailer: { $regex: searchTerm, $options: 'i' } },
          { address: { $regex: searchTerm, $options: 'i' } },
          { suburb: { $regex: searchTerm, $options: 'i' } },
          { store_id: { $regex: searchTerm, $options: 'i' } },
        ];
      }
      if (retailer) {
        searchQuery.retailer = { $regex: retailer, $options: 'i' };
      }
      if (state) {
        searchQuery.state = state.toUpperCase();
      }
      if (suburb) {
        searchQuery.suburb = { $regex: suburb, $options: 'i' };
      }
      let storeLocations = [];
      let totalCount = 0;
      if (search && search.trim()) {
        const matchedDocs = await storeLocationStorage.find(searchQuery).toArray();
        totalCount = matchedDocs.length;
        storeLocations = matchedDocs.slice(skip, skip + Number.parseInt(limit));
      } else {
        totalCount = await storeLocationStorage.countDocuments(searchQuery);
        storeLocations = await storeLocationStorage
          .find(searchQuery)
          .skip(skip)
          .limit(Number.parseInt(limit))
          .sort({ store_name: 1 })
          .toArray();
      }
      await toolAnalyticsStorage.insertOne({
        type: 'admin_access',
        resource: 'store_locations',
        timestamp: new Date(),
        userInfo: getUserInfoFromRequest(req),
        searchTerm: search || null,
        filters: { retailer, state, suburb },
        resultCount: storeLocations.length,
      });

      res.json({
        data: storeLocations,
        pagination: {
          currentPage: Number.parseInt(page),
          totalPages: Math.ceil(totalCount / Number.parseInt(limit)),
          totalItems: totalCount,
          itemsPerPage: Number.parseInt(limit),
        },
      });
    } catch (error) {
      console.error('Error fetching store locations:', error);
      res.status(500).json({ error: 'Failed to fetch store locations' });
    }
  });
  router.get('/admin/store-locations/:id', async (req, res) => {
    try {
      const { id } = req.params;

      let storeLocation;
      if (ObjectId.isValid(id)) {
        storeLocation = await storeLocationStorage.findOne({ _id: new ObjectId(id) });
      } else {
        storeLocation = await storeLocationStorage.findOne({ store_id: id });
      }

      if (!storeLocation) {
        return res.status(404).json({ error: 'Store location not found' });
      }

      await toolAnalyticsStorage.insertOne({
        type: 'admin_access',
        resource: 'store_location_detail',
        resourceId: id,
        timestamp: new Date(),
        userInfo: getUserInfoFromRequest(req),
      });

      res.json(storeLocation);
    } catch (error) {
      console.error('Error fetching store location:', error);
      res.status(500).json({ error: 'Failed to fetch store location' });
    }
  });
  router.post('/admin/store-locations', async (req, res) => {
    try {
      const actor = getAdminActorFromRequest(req);
      const {
        store_id,
        store_name,
        retailer,
        address,
        suburb,
        state,
        postcode,
        lat,
        lon,
        is_rural = false,
        updatedBy = 'admin',
      } = req.body;
      if (!store_id || !store_name || !retailer || !address) {
        return res.status(400).json({
          error: 'Missing required fields: store_id, store_name, retailer, address',
        });
      }
      const existingStore = await storeLocationStorage.findOne({ store_id });
      if (existingStore) {
        return res.status(409).json({ error: 'Store with this store_id already exists' });
      }

      const newStoreLocation = {
        store_id,
        store_name,
        retailer,
        address,
        suburb: suburb || '',
        state: state ? state.toUpperCase() : '',
        postcode: postcode || '',
        lat: Number.parseFloat(lat) || 0,
        lon: Number.parseFloat(lon) || 0,
        is_rural: Boolean(is_rural),
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: updatedBy,
      };

      const result = await storeLocationStorage.insertOne(newStoreLocation);

      // Log audit
      await auditLogger.logAudit({
        action: 'CREATE',
        resource: 'store_location',
        resourceId: result.insertedId.toString(),
        userId: updatedBy || actor.userId,
        userEmail: actor.userEmail,
        role: actor.role,
        newData: newStoreLocation,
        metadata: {
          store_id,
          store_name,
          retailer,
          adminAction: true,
        },
        ...getUserInfoFromRequest(req),
      });

      res.status(201).json({
        success: true,
        message: 'Store location created successfully',
        data: { ...newStoreLocation, _id: result.insertedId },
      });
    } catch (error) {
      console.error('Error creating store location:', error);
      res.status(500).json({ error: 'Failed to create store location' });
    }
  });
  router.put('/admin/store-locations/:id', async (req, res) => {
    try {
      const actor = getAdminActorFromRequest(req);
      const { id } = req.params;
      const {
        store_id,
        store_name,
        retailer,
        address,
        suburb,
        state,
        postcode,
        lat,
        lon,
        is_rural,
        updatedBy = 'admin',
      } = req.body;
      let query;
      if (ObjectId.isValid(id)) {
        query = { _id: new ObjectId(id) };
      } else {
        query = { store_id: id };
      }
      const existingStore = await storeLocationStorage.findOne(query);
      if (!existingStore) {
        return res.status(404).json({ error: 'Store location not found' });
      }
      const updateData = {
        updatedAt: new Date(),
        updatedBy,
      };
      if (store_id !== undefined) updateData.store_id = store_id;
      if (store_name !== undefined) updateData.store_name = store_name;
      if (retailer !== undefined) updateData.retailer = retailer;
      if (address !== undefined) updateData.address = address;
      if (suburb !== undefined) updateData.suburb = suburb;
      if (state !== undefined) updateData.state = state.toUpperCase();
      if (postcode !== undefined) updateData.postcode = postcode;
      if (lat !== undefined) updateData.lat = Number.parseFloat(lat);
      if (lon !== undefined) updateData.lon = Number.parseFloat(lon);
      if (is_rural !== undefined) updateData.is_rural = Boolean(is_rural);
      await storeLocationStorage.updateOne(query, { $set: updateData });
      await auditLogger.logAudit({
        action: 'UPDATE',
        resource: 'store_location',
        resourceId: existingStore._id.toString(),
        userId: updatedBy || actor.userId,
        userEmail: actor.userEmail,
        role: actor.role,
        oldData: existingStore,
        newData: updateData,
        metadata: {
          store_id: existingStore.store_id,
          updatedFields: Object.keys(updateData).filter((k) => k !== 'updatedAt' && k !== 'updatedBy'),
          adminAction: true,
        },
        ...getUserInfoFromRequest(req),
      });
      res.json({
        success: true,
        message: 'Store location updated successfully',
      });
    } catch (error) {
      console.error('Error updating store location:', error);
      res.status(500).json({ error: 'Failed to update store location' });
    }
  });
  router.delete('/admin/store-locations/:id', async (req, res) => {
    try {
      const actor = getAdminActorFromRequest(req);
      const { id } = req.params;
      const { updatedBy = 'admin' } = req.body;

      let query;
      if (ObjectId.isValid(id)) {
        query = { _id: new ObjectId(id) };
      } else {
        query = { store_id: id };
      }

      const existingStore = await storeLocationStorage.findOne(query);
      if (!existingStore) {
        return res.status(404).json({ error: 'Store location not found' });
      }

      await storeLocationStorage.deleteOne(query);
      await auditLogger.logAudit({
        action: 'DELETE',
        resource: 'store_location',
        resourceId: existingStore._id.toString(),
        userId: updatedBy || actor.userId,
        userEmail: actor.userEmail,
        role: actor.role,
        oldData: existingStore,
        metadata: {
          store_id: existingStore.store_id,
          store_name: existingStore.store_name,
          retailer: existingStore.retailer,
          adminAction: true,
        },
        ...getUserInfoFromRequest(req),
      });

      res.json({
        success: true,
        message: 'Store location deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting store location:', error);
      res.status(500).json({ error: 'Failed to delete store location' });
    }
  });
  router.get('/store-locations/by-retailer/:retailer', async (req, res) => {
    try {
      const { retailer } = req.params;
      const { lat, lon, radius = 50 } = req.query;
      const query = { retailer: { $regex: retailer, $options: 'i' } };

      const storeLocations = await storeLocationStorage.find(query).toArray();
      if (lat && lon) {
        const userLat = Number.parseFloat(lat);
        const userLon = Number.parseFloat(lon);
        const radiusKm = Number.parseFloat(radius);

        const storesWithDistance = storeLocations
          .map((store) => {
            const distance = calculateDistance(userLat, userLon, store.lat, store.lon);
            return { ...store, distance };
          })
          .filter((store) => store.distance <= radiusKm)
          .sort((a, b) => a.distance - b.distance);

        return res.json(storesWithDistance);
      }
      res.json(storeLocations);
    } catch (error) {
      console.error('Error fetching stores by retailer:', error);
      res.status(500).json({ error: 'Failed to fetch store locations' });
    }
  });
  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  return router;
};
