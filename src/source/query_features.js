// @flow

import type SourceCache from './source_cache';
import type StyleLayer from '../style/style_layer';
import type Coordinate from '../geo/coordinate';
import type CollisionIndex from '../symbol/collision_index';
import type CrossTileSymbolIndex from '../symbol/cross_tile_symbol_index';
import type Transform from '../geo/transform';

export function queryRenderedFeatures(sourceCache: SourceCache,
                            styleLayers: {[string]: StyleLayer},
                            queryGeometry: Array<Coordinate>,
                            params: { filter: FilterSpecification, layers: Array<string> },
                            transform: Transform) {
    const maxPitchScaleFactor = transform.maxPitchScaleFactor();
    const tilesIn = sourceCache.tilesIn(queryGeometry, maxPitchScaleFactor);

    tilesIn.sort(sortTilesIn);

    const renderedFeatureLayers = [];
    for (const tileIn of tilesIn) {
        renderedFeatureLayers.push({
            wrappedTileID: tileIn.tileID.wrapped().key,
            queryResults: tileIn.tile.queryRenderedFeatures(
                styleLayers,
                tileIn.queryGeometry,
                tileIn.scale,
                params,
                transform,
                maxPitchScaleFactor,
                sourceCache.transform.calculatePosMatrix(tileIn.tileID.toUnwrapped()))
        });
    }

    return mergeRenderedFeatureLayers(renderedFeatureLayers);
}

export function queryRenderedSymbols(styleLayers: {[string]: StyleLayer},
                            queryGeometry: Array<Point>,
                            params: { filter: FilterSpecification, layers: Array<string> },
                            collisionIndex: CollisionIndex,
                            crossTileSymbolIndex: CrossTileSymbolIndex) {
    const result = {};
    const renderedSymbols = collisionIndex.queryRenderedSymbols(queryGeometry);
    for (const bucketInstanceId of Object.keys(renderedSymbols).map(Number)) {
        const queryData = crossTileSymbolIndex.retainedBuckets[bucketInstanceId];
        const bucketSymbols = queryData.featureIndex.lookupSymbolFeatures(
                renderedSymbols[bucketInstanceId],
                queryData.bucketIndex,
                queryData.sourceLayerIndex,
                params.filter,
                params.layers,
                styleLayers);
        for (const layerID in bucketSymbols) {
            const resultFeatures = result[layerID] = result[layerID] || [];
            for (const symbolFeature of bucketSymbols[layerID]) {
                resultFeatures.push(symbolFeature.feature);
            }
        }
    }
    return result;
}

export function querySourceFeatures(sourceCache: SourceCache, params: any) {
    const tiles = sourceCache.getRenderableIds().map((id) => {
        return sourceCache.getTileByID(id);
    });

    const result = [];

    const dataTiles = {};
    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        const dataID = tile.tileID.canonical.key;
        if (!dataTiles[dataID]) {
            dataTiles[dataID] = true;
            tile.querySourceFeatures(result, params);
        }
    }

    return result;
}

function sortTilesIn(a, b) {
    const idA = a.tileID;
    const idB = b.tileID;
    return (idA.overscaledZ - idB.overscaledZ) || (idA.canonical.y - idB.canonical.y) || (idA.wrap - idB.wrap) || (idA.canonical.x - idB.canonical.x);
}

function mergeRenderedFeatureLayers(tiles) {
    // Merge results from all tiles, but if two tiles share the same
    // wrapped ID, don't duplicate features between the two tiles
    const result = {};
    const wrappedIDLayerMap = {};
    for (const tile of tiles) {
        const queryResults = tile.queryResults;
        const wrappedID = tile.wrappedTileID;
        const wrappedIDLayers = wrappedIDLayerMap[wrappedID] = wrappedIDLayerMap[wrappedID] || {};
        for (const layerID in queryResults) {
            const tileFeatures = queryResults[layerID];
            const wrappedIDFeatures = wrappedIDLayers[layerID] = wrappedIDLayers[layerID] || {};
            const resultFeatures = result[layerID] = result[layerID] || [];
            for (const tileFeature of tileFeatures) {
                if (!wrappedIDFeatures[tileFeature.featureIndex]) {
                    wrappedIDFeatures[tileFeature.featureIndex] = true;
                    resultFeatures.push(tileFeature.feature);
                }
            }
        }
    }
    return result;
}
